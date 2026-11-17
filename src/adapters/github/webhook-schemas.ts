import { z } from "zod";

// The path Factoree reads for a repository declaration. A push that adds, modifies, or removes
// this path is the trigger for a sync or a removal.
export const FACTOREE_CONFIG_PATH = ".factoree/config.yaml";

// The schemas are not strict. A real GitHub payload carries many fields Factoree does not read,
// and zod strips them. A strict schema refuses every real delivery.

const installationRefSchema = z.object({
  id: z.number(),
  account: z.object({ login: z.string() }),
});

/**
 * A GitHub App installation event. Factoree reads the installation only. It does not sync a
 * repository here, because this event carries no default branch for a repository.
 */
export const installationEventSchema = z.object({
  action: z.string(),
  installation: installationRefSchema,
});

// GitHub lists only the id, the names and the visibility of a repository on this event, never
// its default branch.
const repositoryRefSchema = z.object({ full_name: z.string() });

/**
 * An installation_repositories event. GitHub sends this when an operator grants or revokes the
 * App's access to a repository.
 */
export const installationRepositoriesEventSchema = z.object({
  action: z.string(),
  installation: installationRefSchema,
  repositories_added: z.array(repositoryRefSchema),
  repositories_removed: z.array(repositoryRefSchema).optional(),
});

const pushCommitSchema = z.object({
  added: z.array(z.string()),
  modified: z.array(z.string()),
  removed: z.array(z.string()),
});

/**
 * A push event. Factoree reads the ref, the repository, and each commit's file lists to decide
 * whether this push must trigger a sync or a removal.
 */
export const pushEventSchema = z.object({
  ref: z.string(),
  /** docs/specs/pr-review-merge-and-deploy.md, slice 4. The new head of the pushed branch. */
  after: z.string().optional(),
  deleted: z.boolean().optional(),
  installation: z.object({ id: z.number() }),
  repository: z.object({
    full_name: z.string(),
    default_branch: z.string(),
  }),
  commits: z.array(pushCommitSchema),
});

/**
 * docs/specs/proof-pack-and-visual-evidence.md. A deployment_status event. A CI preview tool
 * reports the URL of the commit it runs in `environment_url`. Factoree reads the state, the URL,
 * the deployed commit, and the repository. docs/specs/pr-review-merge-and-deploy.md adds the
 * deployment id, the environment, the ref and the job log link.
 */
export const deploymentStatusEventSchema = z.object({
  deployment_status: z.object({
    state: z.string(),
    environment_url: z.string().nullish(),
    log_url: z.string().nullish(),
    target_url: z.string().nullish(),
  }),
  deployment: z.object({
    id: z.number().int(),
    sha: z.string(),
    ref: z.string(),
    environment: z.string(),
  }),
  repository: z.object({ full_name: z.string() }),
  installation: z.object({ id: z.number() }),
});

const senderSchema = z.object({ login: z.string() }).nullish();

/**
 * docs/specs/egress-honesty-and-issue-status.md. A pull_request event. Factoree reads the action,
 * the number, whether the pull request merged, the repository and the installation.
 * docs/specs/pr-review-merge-and-deploy.md adds the head and base, the merge commit, the mergeable
 * state, the previous head of a synchronize and a base change of an edit.
 */
export const pullRequestEventSchema = z.object({
  action: z.string(),
  number: z.number().int(),
  before: z.string().nullish(),
  changes: z.object({ base: z.unknown().optional() }).nullish(),
  pull_request: z.object({
    merged: z.boolean().nullish(),
    merge_commit_sha: z.string().nullish(),
    mergeable: z.boolean().nullish(),
    mergeable_state: z.string().nullish(),
    head: z.object({ sha: z.string() }),
    base: z.object({ ref: z.string() }),
  }),
  repository: z.object({ full_name: z.string() }),
  installation: z.object({ id: z.number() }),
  sender: senderSchema,
});

/** docs/specs/pr-review-merge-and-deploy.md. A pull_request_review event. */
export const pullRequestReviewEventSchema = z.object({
  action: z.string(),
  review: z.object({
    id: z.number().int(),
    state: z.string(),
    commit_id: z.string().nullish(),
    body: z.string().nullish(),
    author_association: z.string(),
    user: z.object({ login: z.string(), type: z.string() }),
  }),
  pull_request: z.object({ number: z.number().int() }),
  repository: z.object({ full_name: z.string() }),
  installation: z.object({ id: z.number() }),
});

/**
 * docs/specs/pr-review-merge-and-deploy.md. A check_run event. GitHub lists the pull requests of the
 * head commit only for a branch of the same repository, so Factoree routes by the head commit.
 */
export const checkRunEventSchema = z.object({
  action: z.string(),
  check_run: z.object({
    id: z.number().int(),
    name: z.string(),
    head_sha: z.string(),
    status: z.string(),
    conclusion: z.string().nullish(),
    details_url: z.string().nullish(),
    app: z.object({ slug: z.string().nullish() }).nullish(),
  }),
  repository: z.object({ full_name: z.string() }),
  installation: z.object({ id: z.number() }),
});

/** docs/specs/pr-review-merge-and-deploy.md. A status event: one commit status. */
export const commitStatusEventSchema = z.object({
  sha: z.string(),
  state: z.enum(["pending", "success", "failure", "error"]),
  context: z.string(),
  target_url: z.string().nullish(),
  repository: z.object({ full_name: z.string() }),
  installation: z.object({ id: z.number() }),
  sender: senderSchema,
});
