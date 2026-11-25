import { issueKeyOf, renderOwnedBlock, type PullRequestBodyFacts } from "./pull-request-body.js";

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
  /**
   * docs/specs/change-sets.md, DI-21.152. Open, merged or closed, and the base branch, when GitHub
   * answers them. The preflight of a change set reads them to find a foreign pull request.
   */
  state?: "open" | "merged" | "closed";
  baseBranch?: string;
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
  /** docs/specs/pr-body-for-humans.md, DI-21.217. The current body of the pull request, or null for an empty one. */
  body(slug: string, number: number, githubInstallationId: string): Promise<string | null>;
  /** docs/specs/change-sets.md, DI-21.152. Replaces the body, to add the links to the sibling pull requests. */
  updateBody(slug: string, number: number, body: string, githubInstallationId: string): Promise<void>;
  /** DI-21.153. One comment on the conversation of the pull request. */
  comment(slug: string, number: number, body: string, githubInstallationId: string): Promise<void>;
  /** DI-21.153. Closes the pull request without a merge. */
  close(slug: string, number: number, githubInstallationId: string): Promise<void>;
  /** DI-21.153. Deletes the branch. A branch that does not exist is no error. */
  deleteBranch(slug: string, branch: string, githubInstallationId: string): Promise<void>;
}

const MAX_TITLE = 120;

/**
 * docs/specs/pr-body-for-humans.md, DI-21.218. The work item title, then the Linear key in
 * parentheses, at most 120 characters. The author already shows the Factoree app, so no prefix.
 */
export const buildPullRequestTitle = (input: { workItemTitle: string; workItemUrl: string | null }): string => {
  const key = issueKeyOf(input.workItemUrl);
  const suffix = key === null ? "" : ` (${key})`;
  const room = MAX_TITLE - suffix.length;
  const title = input.workItemTitle.trim().replace(/\s+/g, " ");
  return (title.length <= room ? title : `${title.slice(0, room - 1)}…`) + suffix;
};

/**
 * AT-29, amended by docs/specs/pr-body-for-humans.md. The body names the Work Item, the Run
 * identifier, the base SHA, the patch hash and the verification summary, now in the collapsed Run
 * metadata of the owned block. The body carries no raw log, because SDD section 47 forbids a log
 * dump in the human-facing record. The same restraint applies here.
 */
export const buildPullRequestBody = (facts: PullRequestBodyFacts): string => renderOwnedBlock(facts);
