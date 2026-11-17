import { HOST_CREDENTIAL_KINDS, hostCredentialSecretName, type HostCredential, type HostCredentialKind, type HostCredentialStore } from "~/domain/products/host-credentials.js";
import type { FactoreePrismaClient } from "./client.js";

const kindOf = (value: string): HostCredentialKind =>
  (HOST_CREDENTIAL_KINDS as readonly string[]).includes(value) ? (value as HostCredentialKind) : "header";

/** docs/specs/host-credentials.md. The host credentials of each product, in the order the operator set. */
export class PrismaHostCredentialStore implements HostCredentialStore {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async list(tenantId: string, productId: string): Promise<HostCredential[]> {
    const rows = await this.prisma.hostCredential.findMany({ where: { tenantId, productId }, orderBy: { position: "asc" } });
    return rows.map((row) => ({
      kind: kindOf(row.kind),
      host: row.host,
      username: row.username,
      headerName: row.headerName,
      pathPrefix: row.pathPrefix,
      realmHost: row.realmHost,
      realmPath: row.realmPath,
      redirectHosts: row.redirectHosts,
      repositories: row.repositories,
      githubInstallationId: row.githubInstallationId,
    }));
  }

  async replace(tenantId: string, productId: string, credentials: readonly HostCredential[]): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.hostCredential.deleteMany({ where: { tenantId, productId } }),
      this.prisma.hostCredential.createMany({
        data: credentials.map((credential, position) => ({
          tenantId,
          productId,
          position,
          kind: credential.kind,
          host: credential.host,
          username: credential.username,
          headerName: credential.headerName,
          pathPrefix: credential.pathPrefix,
          realmHost: credential.realmHost,
          realmPath: credential.realmPath,
          redirectHosts: credential.redirectHosts,
          repositories: credential.repositories,
          githubInstallationId: credential.githubInstallationId,
          secretName: credential.kind === "github" ? null : hostCredentialSecretName(credential.host),
        })),
      }),
    ]);
  }
}
