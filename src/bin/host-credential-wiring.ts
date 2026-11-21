import { derivedHostCoverageOf, type DerivedHostCoverage } from "~/domain/setup/derived-hosts.js";
import type { Prisma } from "@prisma/client";
import type { GitHubTokenProvider } from "~/domain/products/github-token-provider.js";
import {
  credentialHostsOf,
  credentialKeyOf,
  GITHUB_REBIND_AFTER_MS,
  GITHUB_TOKEN_MIN_REMAINING_MS,
  resolveHostCredentials,
  type HostCredentialAccess,
} from "~/domain/products/host-credentials.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import { applyEgress, type CredentialBindingStore } from "~/domain/runs/credential-egress.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaHostCredentialStore } from "~/persistence/prisma/host-credential.prisma.js";
import type { Logger } from "~/telemetry/logger.js";

/** docs/specs/host-credentials.md. The host credentials of each product, as the worker reads them. */
export const createHostCredentialWiring = (dependencies: {
  prisma: FactoreePrismaClient;
  secrets: () => SecretStore;
  tokens: () => GitHubTokenProvider;
}) => {
  const store = new PrismaHostCredentialStore(dependencies.prisma);
  const access = (tenantId: string, productId: string, checkoutRepositories: readonly string[] = []): Promise<HostCredentialAccess> =>
    resolveHostCredentials(
      {
        credentials: store,
        secrets: dependencies.secrets(),
        githubToken: (installationId, repositories) =>
          dependencies.tokens().tokenForInstallation(installationId, { contents: "read" }, repositories, {
            minRemainingMs: GITHUB_TOKEN_MIN_REMAINING_MS,
          }),
        productRepositories: async (tenant, product, installationId) => {
          const where: Prisma.RepositoryWhereInput = { tenantId: tenant, productId: product, githubInstallationId: installationId, absentSince: null, membership: "accepted" };
          return (await dependencies.prisma.repository.findMany({ where, select: { fullName: true } })).map((row) => row.fullName);
        },
      },
      tenantId,
      productId,
      checkoutRepositories,
    );
  return {
    store,
    access,
    hosts: async (tenantId: string, productId: string): Promise<string[]> => credentialHostsOf(await store.list(tenantId, productId)),
    key: async (tenantId: string, productId: string): Promise<string[]> => credentialKeyOf(await store.list(tenantId, productId)),
    /** docs/specs/private-stack-onboarding.md. What already covers a derived host of the product. */
    coverage: async (tenantId: string, productId: string): Promise<DerivedHostCoverage> => {
      const product = await dependencies.prisma.product.findUnique({ where: { id: productId }, select: { allowedDomains: true } });
      const repositories = await dependencies.prisma.repository.findMany({ where: { tenantId, productId, absentSince: null, membership: "accepted" }, select: { fullName: true } });
      return derivedHostCoverageOf(product?.allowedDomains ?? [], await store.list(tenantId, productId), repositories.map((row) => row.fullName));
    },
  };
};

/**
 * docs/specs/host-credentials.md. Binds a new `github` token on each live sandbox whose binding is
 * older than the rebind age, with the egress list it applied last. An installation token expires
 * after 1 hour, and no provider has a refresh callback. A failure on one sandbox leaves the others.
 */
export const rebindGitHubTokens = async (dependencies: {
  bindings: CredentialBindingStore;
  access: (tenantId: string, productId: string, checkoutRepositories: readonly string[]) => Promise<HostCredentialAccess>;
  sandbox: Sandbox;
  logger: Logger;
  now?: Date;
}): Promise<number> => {
  const now = dependencies.now ?? new Date();
  const due = await dependencies.bindings.due(new Date(now.getTime() - GITHUB_REBIND_AFTER_MS), 200);
  let rebound = 0;
  for (const record of due) {
    const ref = { id: record.sandboxId, adapter: record.adapter, workspacePath: "" };
    try {
      const access = await dependencies.access(record.tenantId, record.productId, record.repositories);
      await applyEgress(dependencies.sandbox, ref, record.hosts, {
        tenantId: record.tenantId,
        productId: record.productId,
        access,
        store: dependencies.bindings,
        repositories: record.repositories,
      });
      rebound += 1;
    } catch (error) {
      dependencies.logger.warn("the github token of a sandbox was not bound again", {
        sandbox_id: record.sandboxId,
        adapter: record.adapter,
        step: "host_credentials",
        error: String(error).slice(0, 500),
      });
    }
  }
  return rebound;
};
