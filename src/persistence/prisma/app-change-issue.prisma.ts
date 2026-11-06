import type { FactoreePrismaClient } from "./client.js";
import { isTerminalRunStatus, type RunStatus } from "~/domain/runs/run-status.js";
import type {
  AppChangeIssueOutcome,
  AppChangeIssueRecord,
  AppChangeIssueRun,
  AppChangeIssueStore,
} from "~/domain/setup/app-change-issues.js";

type Row = Awaited<ReturnType<FactoreePrismaClient["setupAppChangeIssue"]["findFirstOrThrow"]>>;

const toRecord = (row: Row): AppChangeIssueRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  productId: row.productId,
  setupId: row.setupId,
  repositoryFullName: row.repositoryFullName,
  changes: row.changes,
  linearIssueId: row.linearIssueId,
  linearIssueIdentifier: row.linearIssueIdentifier,
  outcome: row.outcome === "merged" || row.outcome === "not_merged" ? row.outcome : null,
  createdAt: row.createdAt,
  endedAt: row.endedAt,
});

/** docs/specs/setup-app-change-issues.md. The `setup_app_change_issue` table. */
export class PrismaAppChangeIssueStore implements AppChangeIssueStore {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async create(
    input: Pick<AppChangeIssueRecord, "tenantId" | "productId" | "setupId" | "repositoryFullName" | "changes" | "linearIssueId" | "linearIssueIdentifier">,
  ): Promise<AppChangeIssueRecord> {
    return toRecord(await this.prisma.setupAppChangeIssue.create({ data: input }));
  }

  async listForRepository(tenantId: string, repositoryFullName: string): Promise<AppChangeIssueRecord[]> {
    const rows = await this.prisma.setupAppChangeIssue.findMany({ where: { tenantId, repositoryFullName }, orderBy: { createdAt: "asc" } });
    return rows.map(toRecord);
  }

  async setOutcome(id: string, outcome: AppChangeIssueOutcome, at: Date): Promise<void> {
    await this.prisma.setupAppChangeIssue.update({ where: { id }, data: { outcome, endedAt: at } });
  }

  async latestRun(tenantId: string, linearIssueId: string): Promise<AppChangeIssueRun | null> {
    const run = await this.prisma.run.findFirst({
      where: { tenantId, linearIssueId },
      orderBy: { createdAt: "desc" },
      select: { status: true, targets: { select: { pullRequestUrl: true } } },
    });
    if (run === null) return null;
    return {
      terminal: isTerminalRunStatus(run.status as RunStatus),
      pullRequestUrl: run.targets.find((target) => target.pullRequestUrl !== null)?.pullRequestUrl ?? null,
    };
  }
}
