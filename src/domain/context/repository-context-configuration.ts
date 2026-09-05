import type { RepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { FACTOREE_CONFIG_PATH, parseFactoreeConfig } from "~/domain/products/factoree-config.js";

/**
 * SDD section 15. The `context` block governs discovery, and SDD section 49 puts discovery
 * before the sandbox exists. The file is therefore read on the control plane, at the SHA the
 * checkout will later use, through the same read-only git port discovery already uses.
 */
export interface RepositoryContextConfiguration {
  /** SDD section 19. This repository asks for Backstage topology discovery. */
  backstageEnabled: boolean;
  /** SDD section 20. This repository accepts a reference repository Factoree discovers. */
  automaticReferenceDiscovery: boolean;
}

/** SDD section 18 disables broad retrieval by default, so both switches start off. */
export const DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION: RepositoryContextConfiguration = {
  backstageEnabled: false,
  automaticReferenceDiscovery: false,
};

/**
 * Reads the block. A missing file, an invalid file, and an unreachable repository all yield the
 * defaults. SDD section 15 is enforced against the real checkout in `SandboxManager`, which
 * fails the Run there. A second enforcement point here would fail a Run twice for one fault, and
 * would let a transient read fault stop a Run that has a valid file. See controller decision 3.
 */
export const readRepositoryContextConfiguration = async (
  reader: RepositoryReader,
  url: string,
  ref: string,
): Promise<RepositoryContextConfiguration> => {
  try {
    const sha = await reader.resolveRef(url, ref);
    const text = await reader.readBlob(url, sha, FACTOREE_CONFIG_PATH);
    if (text === null) return DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION;
    const config = parseFactoreeConfig(text);
    return {
      backstageEnabled: config.context.backstage.enabled,
      automaticReferenceDiscovery: config.context.referenceRepositories.automaticDiscovery,
    };
  } catch {
    return DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION;
  }
};
