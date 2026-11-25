/**
 * docs/specs/retro-agent.md. What Factoree exports of one ended run for the retro agent. The agent
 * reads data, and P-12 holds: every value comes from Factoree's own records, already redacted.
 */
export interface RetroRunExport {
  id: string;
  status: string;
  workItemTitle: string | null;
  workItemUrl: string | null;
  autonomyLevel: string;
  failureReason: string | null;
  failureMessage: string | null;
  repairCount: number;
  createdAt: string;
  completedAt: string | null;
  followUpOfRunId: string | null;
  /** The redacted human reply that started this follow-up run. */
  followUpReply: string | null;
  repositories: string[];
  stages: Array<{ stage: string; attempt: number; durationMs: number }>;
  /** The faults and decisions of the run, with their typed detail and retained logs. */
  events: Array<{ stage: string; attempt: number; role: string | null; kind: string; message: string; detail: unknown }>;
  reviewFindings: Array<{ attempt: number; severity: string; category: string; description: string; blocking: boolean; decisionReason: string }>;
  sessions: Array<{ role: string; attempt: number; runner: string; model: string | null; outcome: string; costUsd: number | null; durationMs: number }>;
  /** The path of each kept transcript of the run in the sandbox, relative to the export directory. */
  transcripts: string[];
}

/** The numbers the Retro page shows per product, over the runs one retro read. */
export interface RetroMetrics {
  runs: number;
  /** The share of runs that ended done with no repair, or null with no run. */
  firstPassRate: number | null;
  repairsPerRun: number | null;
  hungSessions: number;
  /** The mean cost of a run, or null when no session reported a cost. */
  costPerRun: number | null;
}

const DONE = new Set(["READY_FOR_HUMAN", "REPORTED", "ANSWERED"]);

export const isDoneStatus = (status: string): boolean => DONE.has(status);

export const retroMetricsOf = (runs: readonly RetroRunExport[]): RetroMetrics => {
  if (runs.length === 0) return { runs: 0, firstPassRate: null, repairsPerRun: null, hungSessions: 0, costPerRun: null };
  const firstPass = runs.filter((run) => isDoneStatus(run.status) && run.repairCount === 0).length;
  const repairs = runs.reduce((sum, run) => sum + run.repairCount, 0);
  const hung = runs.reduce((sum, run) => sum + run.sessions.filter((session) => session.outcome === "hung").length, 0);
  const costs = runs.flatMap((run) => run.sessions.map((session) => session.costUsd).filter((cost): cost is number => cost !== null));
  return {
    runs: runs.length,
    firstPassRate: firstPass / runs.length,
    repairsPerRun: repairs / runs.length,
    hungSessions: hung,
    costPerRun: costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0) / runs.length,
  };
};

/** The most runs one retro session reads, so one session stays inside the model's context. */
export const MAX_RETRO_RUNS = 200;

/** The window of the first retro of a tenant, which has no earlier successful retro. */
export const FIRST_RETRO_WINDOW_MS = 7 * 24 * 60 * 60_000;
