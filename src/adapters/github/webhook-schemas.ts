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
