/** One pull request of the primary repository. */
export interface PullRequestRecord {
  number: number;
  url: string;
  headBranch: string;
}

export interface CreatePullRequestInput {
  /** The `owner/repo` slug of the primary repository. */
  slug: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
}

/**
 * The write port of SDD section 46 step 9. Only the control plane holds an implementation of it.
 * SDD section 30 denies a GitHub write credential to every agent session.
 */
export interface PullRequestPort {
  /** The open pull request for that head branch, or null. Controller decision 8 needs it. */
  findByHead(slug: string, headBranch: string): Promise<PullRequestRecord | null>;
  create(input: CreatePullRequestInput): Promise<PullRequestRecord>;
}

const MAX_TITLE = 120;

export const buildPullRequestTitle = (input: { workItemTitle: string }): string => {
  const prefix = "Factoree: ";
  const room = MAX_TITLE - prefix.length;
  const title = input.workItemTitle.trim().replace(/\s+/g, " ");
  return prefix + (title.length <= room ? title : `${title.slice(0, room - 1)}…`);
};

export interface PullRequestBodyInput {
  workItemTitle: string;
  workItemUrl: string | null;
  runId: string;
  baseSha: string;
  patchSha256: string;
  verificationSummary: string;
  changedFileCount: number;
  repairCount: number;
}

/**
 * AT-29. One pull request must name the Work Item, the Run identifier, the base SHA, the patch
 * hash, and the verification summary. The body carries no raw log, because SDD section 47 forbids
 * a log dump in the human-facing record, and the same restraint applies here.
 */
export const buildPullRequestBody = (input: PullRequestBodyInput): string =>
  [
    "## Factoree change",
    "",
    `Work Item: ${input.workItemTitle}`,
    `Work Item link: ${input.workItemUrl ?? "no Work Item URL"}`,
    `Run ID: ${input.runId}`,
    `Base SHA: ${input.baseSha}`,
    `Patch SHA-256: ${input.patchSha256}`,
    `Changed files: ${input.changedFileCount}`,
    `Repair count: ${input.repairCount}`,
    "",
    "### Deterministic verification",
    "",
    input.verificationSummary,
    "",
    "Factoree applied the verified patch to a clean trusted checkout and proved the patch hash",
    "again before it created this pull request.",
  ].join("\n");
