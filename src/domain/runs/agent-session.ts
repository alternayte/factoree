/**
 * docs/specs/agent-session-usage-and-hangs.md, amending SDD sections 33, 47 and 62. Factoree
 * records the model cost of each agent session. The cost is a metric, never evidence, so a
 * missing record never fails a Run.
 *
 * The workflow imports this file by a relative path, so it imports no SDK and no Node module.
 */

/** The roles of SDD section 33 and docs/specs/refiner-agent.md. */
export type AgentSessionRole = "implementer" | "validator" | "reviewer" | "refiner";

/**
 * How one session ended. `hung` means it wrote no output for the silence limit, and Factoree
 * stopped it. `failed` covers every other session that did not finish, a human stop included.
 */
export type AgentSessionOutcome = "finished" | "hung" | "failed";

/**
 * The usage of one session, as the agent CLI recorded it. A field the CLI does not report is
 * null, never zero, so a total never reads an unknown value as free. DI-14.43.
 */
export interface AgentSessionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  /** The number of model calls, one per assistant message. */
  turns: number | null;
  /** The longest single model call. It shows whether one slow call made the session slow. */
  longestTurnMs: number | null;
}

export interface RecordAgentSessionInput {
  tenantId: string;
  runId: string;
  role: AgentSessionRole;
  /** The Implementer attempt the session belongs to. The refiner always runs in attempt 1. */
  attempt: number;
  runner: string;
  /** The session identifier the CLI gave, or null when the CLI never named one. */
  cliSessionId: string | null;
  model: string | null;
  effort: string | null;
  /** Null when the CLI left no usage record. The row is still written. */
  usage: AgentSessionUsage | null;
  durationMs: number;
  outcome: AgentSessionOutcome;
  /** One key per session, so a Temporal retry of the activity upserts the same row. */
  idempotencyKey: string;
}

export interface AgentSessionRecord extends RecordAgentSessionInput {
  id: string;
  createdAt: Date;
}

/** The `AgentSession` table. One row per agent session. */
export interface AgentSessionStore {
  record(input: RecordAgentSessionInput): Promise<AgentSessionRecord>;
  listForRun(tenantId: string, runId: string): Promise<AgentSessionRecord[]>;
}

/**
 * Issue 6. The newest agent sessions of one Product, newest first. The product page shows which
 * model and effort each role really ran with, because an empty product model means the runner
 * chose. DI-15.16.
 */
export interface ProductAgentSessionReader {
  listRecentForProduct(tenantId: string, productId: string, limit: number): Promise<AgentSessionRecord[]>;
}

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
  "turns",
] as const satisfies ReadonlyArray<keyof AgentSessionUsage>;

/** Adds two known values. An unknown value on both sides stays unknown. */
const plus = (left: number | null, right: number | null): number | null =>
  left === null && right === null ? null : (left ?? 0) + (right ?? 0);

const larger = (left: number | null, right: number | null): number | null =>
  left === null ? right : right === null ? left : Math.max(left, right);

/**
 * The usage of one session that ran in several CLI invocations, for example a refiner that Factoree
 * reminded once. Each invocation reports only its own model calls, so the sum is exact. A part
 * with no record makes the whole unknown, because a partial sum understates the cost. DI-14.43.
 */
export const combineUsage = (parts: ReadonlyArray<AgentSessionUsage | null>): AgentSessionUsage | null => {
  if (parts.length === 0 || parts.some((part) => part === null)) return null;
  const known = parts as AgentSessionUsage[];
  const total: AgentSessionUsage = {
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    turns: null,
    longestTurnMs: null,
  };
  for (const part of known) {
    for (const field of USAGE_FIELDS) total[field] = plus(total[field], part[field]);
    total.longestTurnMs = larger(total.longestTurnMs, part.longestTurnMs);
  }
  return total;
};

/** The total tokens of one usage record: input, output, reasoning and both cache counts. */
export const totalTokens = (usage: AgentSessionUsage): number =>
  (usage.inputTokens ?? 0) +
  (usage.outputTokens ?? 0) +
  (usage.reasoningTokens ?? 0) +
  (usage.cacheReadTokens ?? 0) +
  (usage.cacheWriteTokens ?? 0);

/** The totals of one role, for `proof-pack.json`. */
export interface AgentRoleTotals {
  role: AgentSessionRole;
  sessions: number;
  hung: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** The sum of the session durations. */
  modelTimeMs: number;
  /** The sessions that left no usage record. Their cost is not in `costUsd`. */
  sessionsWithoutUsage: number;
}

export interface AgentUsageTotals {
  roles: AgentRoleTotals[];
  costUsd: number;
  tokens: number;
  modelTimeMs: number;
  sessionsWithoutUsage: number;
}

const ROLE_ORDER: AgentSessionRole[] = ["refiner", "implementer", "validator", "reviewer"];

/** The totals per role and for the whole Run, from the stored rows. */
export const summarizeAgentSessions = (rows: ReadonlyArray<RecordAgentSessionInput>): AgentUsageTotals => {
  const roles: AgentRoleTotals[] = [];
  for (const role of ROLE_ORDER) {
    const own = rows.filter((row) => row.role === role);
    if (own.length === 0) continue;
    const totals: AgentRoleTotals = {
      role,
      sessions: own.length,
      hung: own.filter((row) => row.outcome === "hung").length,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      modelTimeMs: 0,
      sessionsWithoutUsage: 0,
    };
    for (const row of own) {
      totals.modelTimeMs += row.durationMs;
      const usage = row.usage;
      if (usage === null) {
        totals.sessionsWithoutUsage += 1;
        continue;
      }
      totals.inputTokens += usage.inputTokens ?? 0;
      totals.outputTokens += usage.outputTokens ?? 0;
      totals.reasoningTokens += usage.reasoningTokens ?? 0;
      totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
      totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
      totals.costUsd += usage.costUsd ?? 0;
    }
    roles.push(totals);
  }
  return {
    roles,
    costUsd: roles.reduce((sum, role) => sum + role.costUsd, 0),
    tokens: roles.reduce(
      (sum, role) =>
        sum + role.inputTokens + role.outputTokens + role.reasoningTokens + role.cacheReadTokens + role.cacheWriteTokens,
      0,
    ),
    modelTimeMs: roles.reduce((sum, role) => sum + role.modelTimeMs, 0),
    sessionsWithoutUsage: roles.reduce((sum, role) => sum + role.sessionsWithoutUsage, 0),
  };
};

/** The silence limit as a human reads it: whole minutes when it is a whole number of minutes. */
export const describeSilenceLimit = (silenceLimitMs: number): string => {
  const minutes = silenceLimitMs / 60_000;
  if (Number.isInteger(minutes) && minutes > 0) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const seconds = Math.max(1, Math.round(silenceLimitMs / 1_000));
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
};

/** The role as the failure message names it. */
export const describeAgentRole = (role: AgentSessionRole): string =>
  role === "validator" ? "User Validator" : role === "implementer" ? "Implementer" : role === "reviewer" ? "Reviewer" : "refiner";

/**
 * The idempotency key of one session. The first session of a step keeps the key the
 * AgentExecution row always had. The fresh session after a hang adds a suffix, so it writes its
 * own row instead of colliding with the hung one. DI-14.44.
 */
export const agentSessionKey = (runId: string, role: AgentSessionRole, attempt: number | null, afterHang: boolean): string =>
  `run:${runId}:${role}${attempt === null ? "" : `:${attempt}`}${afterHang ? ":after-hang" : ""}`;

const PLAN_CORRECTION_SUFFIX = ":plan-correction";

/**
 * DI-15.23. The key of the one session that corrects a rejected Validation Plan. It keeps the
 * attempt of its pass and adds a marker, so it writes its own row beside the first session.
 */
export const planCorrectionSessionKey = (runId: string, attempt: number, afterHang: boolean): string =>
  `${agentSessionKey(runId, "validator", attempt, afterHang)}${PLAN_CORRECTION_SUFFIX}`;

/** True for the row of a plan correction session. The Proof Pack reads it. */
export const isPlanCorrectionSession = (row: Pick<RecordAgentSessionInput, "role" | "idempotencyKey">): boolean =>
  row.role === "validator" && row.idempotencyKey.endsWith(PLAN_CORRECTION_SUFFIX);
