/**
 * docs/specs/run-visibility.md. The read model of the Runs pages. It reads what Factoree already
 * stores and changes nothing.
 */

export interface RunListItem {
  id: string;
  productId: string;
  productSlug: string;
  productName: string;
  status: string;
  failureReason: string | null;
  failureMessage: string | null;
  workItemTitle: string | null;
  workItemUrl: string | null;
  pullRequestUrl: string | null;
  repairCount: number;
  /** The repair limit the run had. Only a run that posted a proof pack records it. */
  repairLimit: number | null;
  /** The sum of the cost of every agent session that reported one, or null when none did. */
  costUsd: number | null;
  createdAt: Date;
  completedAt: Date | null;
  /**
   * From the start of the work to the end, without the wait for a run slot or a sandbox slot, or
   * null while the run is active (DI-21.56).
   */
  durationMs: number | null;
  /** DI-21.56. The time the run waited for a run slot or a sandbox slot. */
  waitedMs: number;
  /**
   * docs/specs/sandbox-provider-spillover.md. The sandbox provider the run is pinned to: its name,
   * or its id when the provider is gone. Null before the selection.
   */
  sandboxProvider: string | null;
  /**
   * docs/specs/blocked-by-wait.md. Each blocker as the last read saw it, or null when the run never
   * waited or its blockers were never read.
   */
  blockers: RunBlockerView[] | null;
}

export interface RunBlockerView {
  identifier: string;
  url: string | null;
  /** The Linear state type of the blocker issue. */
  state: string;
  /** The pull request of the newest Factoree run of the blocker issue, or null. */
  pullRequestUrl: string | null;
}

export interface RunStageView {
  stage: string;
  attempt: number;
  sandboxId: string | null;
  startedAt: Date;
  endedAt: Date;
}

export interface RunSessionView {
  role: string;
  attempt: number;
  runner: string;
  model: string | null;
  effort: string | null;
  outcome: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  costUsd: number | null;
  turns: number | null;
  modelMs: number | null;
  toolMs: number | null;
  createdAt: Date;
}

export interface RunAssertionView {
  key: string;
  attempt: number;
  method: string;
  statement: string;
  result: string;
  reason: string;
}

export interface RunFindingView {
  attempt: number;
  key: string;
  severity: string;
  category: string;
  evidence: string;
  description: string;
  blocking: boolean;
  decisionReason: string;
}

export interface RunSkillView {
  source: string;
  name: string;
  version: number | null;
  listed: boolean;
  activated: boolean;
}

export interface RunSkillProposalView {
  name: string;
  source: string;
  state: string;
  url: string | null;
  reason: string | null;
}

export interface RunDetail extends RunListItem {
  temporalWorkflowId: string;
  /** Issue #45. True when the status is terminal, so the run takes no stop. */
  terminal: boolean;
  /** Issue #45, DI-21.65. The first stop that reached the workflow, or null. */
  stopRequestedAt: Date | null;
  /** "linear" or "factoree_ui", or null when nobody stopped the run. */
  stopSource: string | null;
  /** The admin who stopped the run from the Factoree UI, or null. */
  stopRequestedBy: string | null;
  /**
   * docs/specs/draft-of-failed-run.md. True when a draft request of the run would start the draft
   * workflow now: a failed run with a patch that no refusal rule stops.
   */
  draftQualifies: boolean;
  /** DI-21.79. The request that started the draft workflow: when, from where, and who. */
  draftRequestedAt: Date | null;
  /** "linear" or "factoree_ui", or null when nobody asked for a draft. */
  draftSource: string | null;
  draftRequestedBy: string | null;
  /** The sandbox retention of the product, in hours. A stopped run keeps its work sprite this long. */
  sandboxRetentionHours: number;
  autonomyLevel: string;
  /** docs/specs/run-recovery.md. The failed run this run follows up, or null. */
  followUpOfRunId: string | null;
  baseSha: string | null;
  commitSha: string | null;
  patchSha256: string | null;
  skillRegistrySet: string | null;
  skillResolutionId: string | null;
  proofPackPostedAt: Date | null;
  /** The proof-pack.json document an agent reads, or null before a proof pack exists. */
  proofPackDocument: unknown;
  stages: RunStageView[];
  sessions: RunSessionView[];
  assertions: RunAssertionView[];
  findings: RunFindingView[];
  skills: RunSkillView[];
  skillProposals: RunSkillProposalView[];
}

export interface RunListQuery {
  tenantId: string;
  productId?: string;
  status?: string;
  /** The cursor the previous page returned, or absent for the first page. */
  cursor?: string;
  limit: number;
}

export interface RunListPage {
  items: RunListItem[];
  /** The cursor of the next page, or null on the last page. */
  nextCursor: string | null;
}

export interface RunViewReader {
  list(query: RunListQuery): Promise<RunListPage>;
  detail(tenantId: string, runId: string): Promise<RunDetail | null>;
}

/** A cursor names the last row of a page: its creation time and its id, newest first. */
export const encodeRunCursor = (createdAt: Date, id: string): string =>
  Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");

export const decodeRunCursor = (cursor: string): { createdAt: Date; id: string } | null => {
  const [time, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (time === undefined || id === undefined || id === "") return null;
  const createdAt = new Date(time);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
};
