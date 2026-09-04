import type { FastifyInstance } from "fastify";
import {
  FACTOREE_CONFIG_PATH,
  installationEventSchema,
  installationRepositoriesEventSchema,
  pushEventSchema,
} from "~/adapters/github/webhook-schemas.js";
import type { DiscoveryOutcome, DiscoveryService } from "~/domain/products/discovery-service.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { Logger } from "~/telemetry/logger.js";

export interface GitHubWebhookDependencies {
  discovery: DiscoveryService;
  tenants: TenantRegistry;
  verifySignature: (raw: string, signature: string) => boolean;
  logger: Logger;
}

/**
 * Resolves the tenant that owns a GitHub App installation. The numeric installation id is
 * stable across an account rename, so this route never resolves by the account login.
 */
const resolveTenantId = async (
  dependencies: GitHubWebhookDependencies,
  installationId: number,
  accountLogin: string | undefined,
): Promise<string | null> => {
  const tenant = await dependencies.tenants.findByGitHubInstallation(String(installationId));
  if (tenant !== null) return tenant.id;
  // No operator has bound this installation to a tenant yet. This is not an error. The event
  // carries no work Factoree can do. GitHub must not redeliver it.
  dependencies.logger.warn("ignored a GitHub event for an unbound installation", {
    installation_id: String(installationId),
    ...(accountLogin === undefined ? {} : { account_login: accountLogin }),
  });
  return null;
};

const touchesConfigPath = (files: string[]): boolean => files.includes(FACTOREE_CONFIG_PATH);

/**
 * Specification section 8. A discovery conflict must not vanish. This route is not yet wired
 * into the running server (discovery is dispatched from tests only today), so no conflict can
 * reach production before that follow-up lands. The follow-up is where a persisted conflict
 * and the operator route that lists it belong. Until then, the worker log is the record: it
 * names the repository, the reason, and, because `DiscoveryService` already folds the
 * offending key or the competing Product's slug into `reason`, an operator can read the line
 * alone and know exactly what to change, with no code open.
 */
const logDiscoveryOutcome = (
  dependencies: GitHubWebhookDependencies,
  fullName: string,
  outcome: DiscoveryOutcome,
): void => {
  if (outcome.kind === "registered") return;
  const level = outcome.kind === "conflict" ? "warn" : "info";
  dependencies.logger[level](`repository discovery did not register ${fullName}: ${outcome.reason}`, {
    repository: fullName,
    outcome: outcome.kind,
    reason: outcome.reason,
  });
};

export const registerGitHubWebhookRoutes = (app: FastifyInstance, dependencies: GitHubWebhookDependencies): void => {
  app.post("/webhooks/github", async (request, reply) => {
    const rawBody = request.rawBody;
    const raw = rawBody ? rawBody.toString("utf8") : "";
    const signature = request.headers["x-hub-signature-256"] as string | undefined;
    if (!dependencies.verifySignature(raw, signature ?? "")) {
      return reply.code(401).send({ error: "invalid_signature" });
    }

    const event = request.headers["x-github-event"] as string | undefined;

    if (event === "installation_repositories") {
      const parsed = installationRepositoriesEventSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(200).send({ status: "ignored", reason: "unsupported payload" });

      const tenantId = await resolveTenantId(
        dependencies,
        parsed.data.installation.id,
        parsed.data.installation.account.login,
      );
      if (tenantId !== null) {
        for (const repository of parsed.data.repositories_added) {
          const outcome = await dependencies.discovery.syncRepository(
            tenantId,
            repository.full_name,
            repository.default_branch,
          );
          logDiscoveryOutcome(dependencies, repository.full_name, outcome);
        }
        for (const repository of parsed.data.repositories_removed ?? []) {
          await dependencies.discovery.markAbsent(tenantId, repository.full_name);
        }
      }
      return reply.code(200).send({ status: "handled" });
    }

    if (event === "push") {
      const parsed = pushEventSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(200).send({ status: "ignored", reason: "unsupported payload" });

      const { ref, repository, commits, installation } = parsed.data;
      if (ref !== `refs/heads/${repository.default_branch}`) {
        return reply.code(200).send({ status: "ignored", reason: "not the default branch" });
      }

      let added = false;
      let modified = false;
      let removed = false;
      for (const commit of commits) {
        if (touchesConfigPath(commit.added)) added = true;
        if (touchesConfigPath(commit.modified)) modified = true;
        if (touchesConfigPath(commit.removed)) removed = true;
      }

      if (added || modified || removed) {
        const tenantId = await resolveTenantId(dependencies, installation.id, undefined);
        if (tenantId !== null) {
          if (removed && !added && !modified) {
            await dependencies.discovery.markAbsent(tenantId, repository.full_name);
          } else {
            const outcome = await dependencies.discovery.syncRepository(
              tenantId,
              repository.full_name,
              repository.default_branch,
            );
            logDiscoveryOutcome(dependencies, repository.full_name, outcome);
          }
        }
      }
      return reply.code(200).send({ status: "handled" });
    }

    if (event === "installation") {
      const parsed = installationEventSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(200).send({ status: "ignored", reason: "unsupported payload" });
      // GitHub sends no default branch on this event, so there is nothing here to sync. The
      // schema still confirms the payload shape.
      return reply.code(200).send({ status: "handled" });
    }

    return reply.code(200).send({ status: "ignored", reason: "unsupported event" });
  });
};
