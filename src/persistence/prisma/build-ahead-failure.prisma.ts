import type { BuildAheadFailureRecord, BuildAheadFailureStore } from "~/domain/runs/build-ahead.js";
import type { FactoreePrismaClient } from "./client.js";

/** docs/specs/sandbox-provider-spillover.md. One row per tenant, sandbox provider and repository. */
export class PrismaBuildAheadFailureStore implements BuildAheadFailureStore {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async record(failure: BuildAheadFailureRecord): Promise<void> {
    const key = { tenantId: failure.tenantId, providerId: failure.providerId, repositoryUrl: failure.repositoryUrl };
    await this.prisma.buildAheadFailure.upsert({
      where: { tenantId_providerId_repositoryUrl: key },
      create: { ...key, reason: failure.reason, failedAt: failure.failedAt },
      update: { reason: failure.reason, failedAt: failure.failedAt },
    });
  }

  async clear(tenantId: string, providerId: string, repositoryUrl: string): Promise<void> {
    await this.prisma.buildAheadFailure.deleteMany({ where: { tenantId, providerId, repositoryUrl } });
  }

  async failedProviders(tenantId: string, repositoryUrl: string): Promise<string[]> {
    const rows = await this.prisma.buildAheadFailure.findMany({ where: { tenantId, repositoryUrl }, select: { providerId: true } });
    return rows.map((row) => row.providerId);
  }

  async listFor(tenantId: string, repositoryUrls: readonly string[]): Promise<BuildAheadFailureRecord[]> {
    if (repositoryUrls.length === 0) return [];
    return await this.prisma.buildAheadFailure.findMany({
      where: { tenantId, repositoryUrl: { in: [...repositoryUrls] } },
      orderBy: { failedAt: "desc" },
    });
  }
}
