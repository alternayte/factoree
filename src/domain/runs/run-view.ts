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
