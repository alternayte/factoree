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
 * the deployed commit, and the repository.
 */
export const deploymentStatusEventSchema = z.object({
  deployment_status: z.object({
    state: z.string(),
    environment_url: z.string().nullish(),
  }),
  deployment: z.object({ sha: z.string() }),
  repository: z.object({ full_name: z.string() }),
  installation: z.object({ id: z.number() }),
});

/**
 * docs/specs/egress-honesty-and-issue-status.md. A pull_request event. Factoree reads the action,
 * the number, whether the pull request merged, the repository and the installation.
 */
export const pullRequestEventSchema = z.object({
  action: z.string(),
  number: z.number().int(),
  pull_request: z.object({ merged: z.boolean().nullish() }),
  repository: z.object({ full_name: z.string() }),
  installation: z.object({ id: z.number() }),
});
