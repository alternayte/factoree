import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import { largestMinimum, type SandboxMinimum } from "~/domain/settings/install-settings.js";

/** `owner/name` of a GitHub repository URL, or null for a URL of another form. */
const fullNameOf = (url: string): string | null => {
  try {
    const parts = new URL(url).pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
    return parts.length === 2 && parts[0] !== "" && parts[1] !== "" ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
};

/**
 * docs/specs/sandbox-memory-and-size.md. The `sandbox` minimum that discovery stored for the
 * repositories of one sandbox, the largest of them per field. A run picks its provider and creates
 * its work sprite before it reads `.factoree/config.yaml`, so the size comes from the stored row.
 * A repository discovery does not know asks for nothing.
 */
export const sandboxMinimumOfRepositories = async (
  repositories: Pick<RepositoryRegistry, "findByFullName">,
  tenantId: string,
  repositoryUrls: readonly string[],
): Promise<SandboxMinimum | null> => {
  const minimums: Array<SandboxMinimum | null> = [];
  for (const url of new Set(repositoryUrls)) {
    const fullName = fullNameOf(url);
    if (fullName === null) continue;
    minimums.push((await repositories.findByFullName(tenantId, fullName))?.sandboxMinimum ?? null);
  }
  return largestMinimum(minimums);
};
