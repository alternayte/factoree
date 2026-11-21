import type { Prisma } from "@prisma/client";
import type { FactoreePrismaClient } from "./client.js";
import {
  ENDED_RUN_VISIBLE_MS,
  LIVE_PULSE_MS,
  approximateStatuses,
  type FloorData,
  type FloorDeploy,
  type FloorPulse,
  type FloorPullRequest,
  type FloorReader,
  type FloorRun,
  type FloorSetup,
  type FloorStatusChange,
  type FloorThroughputDay,
} from "~/domain/runs/floor.js";
import { TERMINAL_RUN_STATUSES } from "~/domain/runs/run-status.js";
import { TOOL_KINDS, type ToolKind } from "~/domain/runs/session-pulse.js";

/** The most runs one floor answer holds. The newest win. */
const MAX_RUNS = 500;
/** The most pulses one replay holds. A pulse every 5 s for 7 days of 3 sessions fits. */
const MAX_PULSES = 400_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The setup statuses of a setup run that has not ended. */
const OPEN_SETUP_STATUSES = ["queued", "running"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const repairLimitOf = (document: Prisma.JsonValue | null): number | null => {
  if (!isRecord(document)) return null;
  const run = document["run"];
  return isRecord(run) && typeof run["repairLimit"] === "number" ? run["repairLimit"] : null;
};

const toolKindOf = (value: string): ToolKind => ((TOOL_KINDS as readonly string[]).includes(value) ? (value as ToolKind) : "think");

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

const runSelect = {
  id: true,
  productId: true,
  status: true,
  workItemTitle: true,
  workItemUrl: true,
  createdAt: true,
  completedAt: true,
  proofPackDocument: true,
  product: { select: { repairMaxAttempts: true } },
  targets: { select: { pullRequestUrl: true, repository: { select: { fullName: true } } } },
  statusChanges: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { fromStatus: true, toStatus: true, createdAt: true } },
  stages: { select: { stage: true, attempt: true, startedAt: true } },
} satisfies Prisma.RunSelect;

type RunRow = Prisma.RunGetPayload<{ select: typeof runSelect }>;

const setupSelect = {
  id: true,
  productId: true,
  repositoryFullName: true,
  status: true,
  createdAt: true,
  endedAt: true,
  statusChanges: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { fromStatus: true, toStatus: true, createdAt: true } },
} satisfies Prisma.RepositorySetupSelect;

type SetupRow = Prisma.RepositorySetupGetPayload<{ select: typeof setupSelect }>;

/**
 * The status history from the trigger rows. A run that changed status before the trigger existed
 * starts with a change whose from status is set: the page gets that status at the creation time,
 * marked approximate.
 */
const historyOf = (
  createdAt: Date,
  changes: Array<{ fromStatus: string | null; toStatus: string; createdAt: Date }>,
): { statuses: FloorStatusChange[]; approximate: boolean } => {
  const statuses = changes.map((change) => ({ status: change.toStatus, at: change.createdAt }));
  const first = changes[0];
  if (first !== undefined && first.fromStatus !== null) {
    return { statuses: [{ status: first.fromStatus, at: createdAt }, ...statuses], approximate: true };
  }
  return { statuses, approximate: false };
};

/** docs/specs/factory-floor.md. The factory floor of one tenant, live or over a past window. */
export class PrismaFloorReader implements FloorReader {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async live(tenantId: string, now: Date): Promise<FloorData> {
    const since = new Date(now.getTime() - ENDED_RUN_VISIBLE_MS);
    // A run is on the live floor while it has not ended, for a day after it ended, and while a
    // pull request it opened is open.
    const runs = await this.prisma.run.findMany({
      where: {
        tenantId,
        OR: [
          { status: { notIn: [...TERMINAL_RUN_STATUSES] } },
          { completedAt: { gte: since } },
          { targets: { some: { pullRequestState: "open" } } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_RUNS,
      select: runSelect,
    });
    const setups = await this.prisma.repositorySetup.findMany({
      where: { tenantId, OR: [{ status: { in: OPEN_SETUP_STATUSES } }, { endedAt: { gte: since } }] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_RUNS,
      select: setupSelect,
    });
    // The newest pulse of each session that still runs.
    const pulseRows = await this.prisma.sessionPulse.findMany({
      where: { tenantId, createdAt: { gte: new Date(now.getTime() - LIVE_PULSE_MS) } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 2_000,
    });
    const seen = new Set<string>();
    const pulses = pulseRows.filter((row) => {
      const key = `${row.runId ?? ""}:${row.setupId ?? ""}:${row.role}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // The throughput covers today and the 6 days before it.
    const from = new Date(`${dayOf(new Date(now.getTime() - 6 * DAY_MS))}T00:00:00.000Z`);
    return this.assemble(tenantId, now, from, now, runs, setups, pulses);
  }

  async replay(tenantId: string, from: Date, to: Date): Promise<FloorData> {
    // A run is in the window when it existed during it: created before its end, and not ended
    // before its start, or with a pull request that was open during it.
    const runs = await this.prisma.run.findMany({
      where: {
        tenantId,
        createdAt: { lte: to },
        OR: [
          { completedAt: null },
          { completedAt: { gte: new Date(from.getTime() - ENDED_RUN_VISIBLE_MS) } },
          { targets: { some: { pullRequestState: "open" } } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_RUNS,
      select: runSelect,
    });
    const setups = await this.prisma.repositorySetup.findMany({
      where: {
        tenantId,
        createdAt: { lte: to },
        OR: [{ endedAt: null }, { endedAt: { gte: new Date(from.getTime() - ENDED_RUN_VISIBLE_MS) } }],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_RUNS,
      select: setupSelect,
    });
    const pulses = await this.prisma.sessionPulse.findMany({
      where: { tenantId, createdAt: { gte: from, lte: to } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_PULSES,
    });
    return this.assemble(tenantId, new Date(), from, to, runs, setups, pulses);
  }

  private async assemble(
    tenantId: string,
    generatedAt: Date,
    from: Date,
    to: Date,
    runRows: RunRow[],
    setupRows: SetupRow[],
    pulseRows: Array<{ runId: string | null; setupId: string | null; role: string; toolKind: string; lastOutputAt: Date; createdAt: Date }>,
  ): Promise<FloorData> {
    const products = await this.prisma.product.findMany({
      where: { tenantId },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, slug: true, linearTeamKey: true, repositories: { orderBy: { fullName: "asc" }, select: { fullName: true } } },
    });
    const runIds = runRows.map((run) => run.id);
    const costs = await this.prisma.agentSession.groupBy({
      by: ["runId"],
      where: { tenantId, runId: { in: runIds } },
      _sum: { costUsd: true },
    });
    const costOf = new Map(costs.map((row) => [row.runId, row._sum.costUsd]));
    const urls = [...new Set(runRows.flatMap((run) => run.targets.flatMap((target) => (target.pullRequestUrl === null ? [] : [target.pullRequestUrl]))))];
    const pullRequests = await this.prisma.pullRequest.findMany({
      where: { tenantId, url: { in: urls } },
      select: { url: true, state: true, createdAt: true, closedAt: true, repository: { select: { fullName: true } } },
    });
    const pullRequestOf = new Map(pullRequests.map((row) => [row.url, row]));
    const deploys = await this.prisma.pullRequestDeploy.findMany({
      where: { tenantId, runId: { in: runIds } },
      orderBy: { createdAt: "asc" },
      select: { runId: true, environment: true, state: true, createdAt: true },
    });
    // A PR follow-up run shares a pull request with an older run of the answer.
    const firstRunOfUrl = new Map<string, { id: string; createdAt: Date }>();
    for (const run of runRows) {
      for (const target of run.targets) {
        if (target.pullRequestUrl === null) continue;
        const known = firstRunOfUrl.get(target.pullRequestUrl);
        if (known === undefined || run.createdAt < known.createdAt) firstRunOfUrl.set(target.pullRequestUrl, { id: run.id, createdAt: run.createdAt });
      }
    }

    const runs: FloorRun[] = runRows.map((run) => {
      const history =
        run.statusChanges.length > 0
          ? historyOf(run.createdAt, run.statusChanges)
          : { statuses: approximateStatuses(run, run.stages), approximate: true };
      const ownPullRequests: FloorPullRequest[] = run.targets.flatMap((target) => {
        if (target.pullRequestUrl === null) return [];
        const row = pullRequestOf.get(target.pullRequestUrl);
        if (row === undefined) return [];
        const state = row.state === "merged" || row.state === "closed" ? row.state : "open";
        return [{ url: row.url, repository: row.repository.fullName, state, openedAt: row.createdAt, closedAt: state === "open" ? null : (row.closedAt ?? null) }];
      });
      const runDeploys: FloorDeploy[] = deploys
        .filter((deploy) => deploy.runId === run.id)
        .map((deploy) => ({ environment: deploy.environment, state: deploy.state === "success" ? "success" : "failure", at: deploy.createdAt }));
      return {
        id: run.id,
        productId: run.productId,
        title: run.workItemTitle,
        url: run.workItemUrl,
        createdAt: run.createdAt,
        repairLimit: repairLimitOf(run.proofPackDocument) ?? run.product.repairMaxAttempts,
        costUsd: costOf.get(run.id) ?? null,
        followsPullRequest: run.targets.some((target) => {
          if (target.pullRequestUrl === null) return false;
          const first = firstRunOfUrl.get(target.pullRequestUrl);
          return first !== undefined && first.id !== run.id;
        }),
        approximate: history.approximate,
        statuses: history.statuses,
        pullRequests: ownPullRequests,
        deploys: runDeploys,
      };
    });

    const setups: FloorSetup[] = setupRows.map((setup) => {
      if (setup.statusChanges.length > 0) {
        const history = historyOf(setup.createdAt, setup.statusChanges);
        return { id: setup.id, productId: setup.productId, repository: setup.repositoryFullName, ...history };
      }
      const statuses: FloorStatusChange[] = [{ status: "running", at: setup.createdAt }];
      if (setup.endedAt !== null) statuses.push({ status: setup.status, at: setup.endedAt });
      return { id: setup.id, productId: setup.productId, repository: setup.repositoryFullName, approximate: true, statuses };
    });

    const pulses: FloorPulse[] = pulseRows.map((row) => ({
      runId: row.runId,
      setupId: row.setupId,
      role: row.role,
      toolKind: toolKindOf(row.toolKind),
      lastOutputAt: row.lastOutputAt,
      at: row.createdAt,
    }));

    return {
      generatedAt,
      from,
      to,
      lines: products.map((product) => ({
        productId: product.id,
        name: product.name,
        slug: product.slug,
        teamKey: product.linearTeamKey,
        repositories: product.repositories.map((repository) => repository.fullName),
      })),
      runs,
      setups,
      pulses,
      throughput: await this.throughput(tenantId, from, to),
    };
  }

  /** Work items in and pull requests merged per UTC day of the window. */
  private async throughput(tenantId: string, from: Date, to: Date): Promise<FloorThroughputDay[]> {
    const arrived = await this.prisma.run.findMany({ where: { tenantId, createdAt: { gte: from, lte: to } }, select: { createdAt: true } });
    const merged = await this.prisma.pullRequest.findMany({
      where: { tenantId, state: "merged", closedAt: { gte: from, lte: to } },
      select: { closedAt: true },
    });
    const days = new Map<string, FloorThroughputDay>();
    for (let at = new Date(`${dayOf(from)}T00:00:00.000Z`).getTime(); at <= to.getTime(); at += DAY_MS) {
      const day = dayOf(new Date(at));
      days.set(day, { day, arrived: 0, merged: 0 });
    }
    for (const row of arrived) {
      const entry = days.get(dayOf(row.createdAt));
      if (entry !== undefined) entry.arrived += 1;
    }
    for (const row of merged) {
      if (row.closedAt === null) continue;
      const entry = days.get(dayOf(row.closedAt));
      if (entry !== undefined) entry.merged += 1;
    }
    return [...days.values()];
  }
}
