/** One pull request of the primary repository. */
export interface PullRequestRecord {
  number: number;
  url: string;
  headBranch: string;
  /**
   * The commit SHA at the tip of the head branch. GitHub already answers it as `head.sha`, so
   * the publication record needs no second network read and no credential on a command line.
   */
  headSha: string;
}

export interface CreatePullRequestInput {
  /** The `owner/repo` slug of the primary repository. */
  slug: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  /** docs/specs/autonomy-levels.md. A draft pull request marks a change a human must promote. */
  draft: boolean;
}

/**
 * The write port of SDD section 46 step 9. Only the control plane holds an implementation of it.
 * SDD section 30 denies a GitHub write credential to every agent session.
 */
export interface PullRequestPort {
  /** The open pull request for that head branch, or null. DI-9.8 needs it. */
  findByHead(slug: string, headBranch: string, githubInstallationId: string): Promise<PullRequestRecord | null>;
  create(input: CreatePullRequestInput, githubInstallationId: string): Promise<PullRequestRecord>;
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
  /**
   * docs/specs/draft-of-failed-run.md. The warning block of a draft of a failed run. It starts the
   * body, and the closing sentence names the last patch, not a verified one.
   */
  draftWarning?: string;
}

/**
 * AT-29. One pull request must name the Work Item, the Run identifier, the base SHA, the patch
 * hash, and the verification summary. The body carries no raw log, because SDD section 47 forbids
 * a log dump in the human-facing record. The same restraint applies here.
 */
export const buildPullRequestBody = (input: PullRequestBodyInput): string =>
  [
    ...(input.draftWarning === undefined ? [] : [input.draftWarning, ""]),
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
    ...(input.draftWarning === undefined
      ? [
          "Factoree applied the verified patch to a clean trusted checkout and proved the patch hash",
          "again before it created this pull request.",
        ]
      : [
          "Factoree applied the last patch a check sprite received to a clean trusted checkout and",
          "proved its hash again before it created this draft. Only a human marks it ready.",
        ]),
  ].join("\n");
