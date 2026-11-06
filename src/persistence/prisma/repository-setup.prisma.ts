import { Prisma } from "@prisma/client";
import type { FactoreePrismaClient } from "./client.js";
import type {
  RepositorySetupRecord,
  RepositorySetupStatus,
  RepositorySetupStore,
  SetupSessionUsage,
} from "~/domain/setup/repository-setup.js";
import type { SetupReport } from "~/domain/setup/setup-report.js";

type Row = Awaited<ReturnType<FactoreePrismaClient["repositorySetup"]["findFirstOrThrow"]>>;

const toRecord = (row: Row): RepositorySetupRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  productId: row.productId,
  repositoryFullName: row.repositoryFullName,
  githubInstallationId: row.githubInstallationId,
  workflowId: row.workflowId,
  status: row.status as RepositorySetupStatus,
  pullRequestUrl: row.pullRequestUrl,
  report: (row.report ?? null) as SetupReport | null,
  failureMessage: row.failureMessage,
  sessionUsage: (row.sessionUsage ?? null) as SetupSessionUsage | null,
  followUpSetupId: row.followUpSetupId,
  inputKey: row.inputKey,
  skippedFromSetupId: row.skippedFromSetupId,
  temporalRunId: row.temporalRunId,
  proofMs: row.proofMs,
  warm: row.warm,
  createdAt: row.createdAt,
  endedAt: row.endedAt,
});

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export class PrismaRepositorySetupStore implements RepositorySetupStore {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async create(
    input: Pick<RepositorySetupRecord, "tenantId" | "productId" | "repositoryFullName" | "githubInstallationId" | "workflowId">,
  ): Promise<RepositorySetupRecord> {
    return toRecord(await this.prisma.repositorySetup.create({ data: { ...input, status: "queued" } }));
  }

  async findById(id: string): Promise<RepositorySetupRecord | null> {
    const row = await this.prisma.repositorySetup.findUnique({ where: { id } });
    return row === null ? null : toRecord(row);
  }

  async latestByProduct(productId: string): Promise<RepositorySetupRecord[]> {
    const rows = await this.prisma.repositorySetup.findMany({
      where: { productId },
      orderBy: { createdAt: "desc" },
      distinct: ["repositoryFullName"],
    });
    return rows.map(toRecord);
  }

  async previousWithReport(productId: string, repositoryFullName: string, before: Date): Promise<RepositorySetupRecord | null> {
    const row = await this.prisma.repositorySetup.findFirst({
      where: { productId, repositoryFullName, createdAt: { lt: before }, report: { not: Prisma.AnyNull } },
      orderBy: { createdAt: "desc" },
    });
    return row === null ? null : toRecord(row);
  }

  async latestOpenPullRequest(tenantId: string, repositoryFullName: string): Promise<RepositorySetupRecord | null> {
    const row = await this.prisma.repositorySetup.findFirst({
      where: { tenantId, repositoryFullName, status: { in: ["proposed", "partial"] }, pullRequestUrl: { not: null } },
      orderBy: { createdAt: "desc" },
    });
    return row === null ? null : toRecord(row);
  }

  async latestEnded(productId: string, repositoryFullName: string, before: Date): Promise<RepositorySetupRecord | null> {
    const row = await this.prisma.repositorySetup.findFirst({
      where: { productId, repositoryFullName, createdAt: { lt: before }, endedAt: { not: null } },
      orderBy: { createdAt: "desc" },
    });
    return row === null ? null : toRecord(row);
  }

  async listForRepository(productId: string, repositoryFullName: string): Promise<RepositorySetupRecord[]> {
    const rows = await this.prisma.repositorySetup.findMany({ where: { productId, repositoryFullName }, orderBy: { createdAt: "desc" } });
    return rows.map(toRecord);
  }

  async update(id: string, patch: Parameters<RepositorySetupStore["update"]>[1]): Promise<void> {
    const { report, sessionUsage, ...rest } = patch;
    await this.prisma.repositorySetup.update({
      where: { id },
      data: {
        ...rest,
        ...(report === undefined || report === null ? {} : { report: json(report) }),
        ...(sessionUsage === undefined || sessionUsage === null ? {} : { sessionUsage: json(sessionUsage) }),
      },
    });
  }
}
