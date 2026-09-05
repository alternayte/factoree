import { z } from "zod";

// The path Factoree reads for a repository declaration. A push that adds, modifies, or removes
// this path is the trigger for a sync or a removal.
export const FACTOREE_CONFIG_PATH = ".factoree/config.yaml";

const installationRefSchema = z
  .object({
    id: z.number(),
    account: z.object({ login: z.string() }).strict(),
  })
  .strict();

/**
 * A GitHub App installation event. Factoree reads the installation only. It does not sync a
 * repository here, because this event carries no default branch for a repository.
 */
export const installationEventSchema = z
  .object({
    action: z.string(),
    installation: installationRefSchema,
  })
  .strict();

const addedRepositorySchema = z
  .object({
    full_name: z.string(),
    default_branch: z.string(),
  })
  .strict();

const removedRepositorySchema = z
  .object({
    full_name: z.string(),
  })
  .strict();

/**
 * An installation_repositories event. GitHub sends this when an operator grants or revokes the
 * App's access to a repository.
 */
export const installationRepositoriesEventSchema = z
  .object({
    action: z.string(),
    installation: installationRefSchema,
    repositories_added: z.array(addedRepositorySchema),
    repositories_removed: z.array(removedRepositorySchema).optional(),
  })
  .strict();

const pushCommitSchema = z
  .object({
    added: z.array(z.string()),
    modified: z.array(z.string()),
    removed: z.array(z.string()),
  })
  .strict();

/**
 * A push event. Factoree reads the ref, the repository, and each commit's file lists to decide
 * whether this push must trigger a sync or a removal.
 */
export const pushEventSchema = z
  .object({
    ref: z.string(),
    installation: z.object({ id: z.number() }).strict(),
    repository: z
      .object({
        full_name: z.string(),
        default_branch: z.string(),
      })
      .strict(),
    commits: z.array(pushCommitSchema),
  })
  .strict();
