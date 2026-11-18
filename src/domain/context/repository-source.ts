import { posix } from "node:path";
import type { RepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { RepositoryReadError } from "~/adapters/github/git-repository-reader.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import { FACTOREE_CONFIG_PATH } from "~/domain/products/factoree-config.js";
import type { AuthorityClass } from "./authority.js";
import type {
  ContextCandidate,
  ContextClassification,
  ContextDiscoveryRequest,
  ContextDocument,
  ContextReference,
  ContextSource,
  DiscoveryRule,
  RepositoryRef,
} from "./context-source.js";
import { DISCOVERY_PRIORITY } from "./context-source.js";
import { topicsIn } from "./topics.js";

export interface PathClassification {
  authority: AuthorityClass;
  reason: string;
  rule: DiscoveryRule;
}

const ADR_DIRECTORIES = new Set(["adr", "adrs", "decisions", "architecture"]);
const DOC_DIRECTORIES = new Set(["doc", "docs"]);
const TEST_DIRECTORIES = new Set(["test", "tests", "spec", "__tests__"]);

const CONTRACT_FILES = new Set([
  "openapi.yaml",
  "openapi.yml",
  "openapi.json",
  "asyncapi.yaml",
  "asyncapi.yml",
]);

const CONTRACT_EXTENSIONS = new Set([".proto", ".graphql"]);

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rb", ".java", ".kt", ".rs", ".cs", ".php",
  ".scala", ".swift",
]);

const ADR_FILE = /^adr[-_]?\d+/i;

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
};

/**
 * Maps a repository path to an SDD section 22 authority class and an SDD section 18 discovery
 * rule. A path that matches no rule is not context, so the caller skips it. The rule order
 * follows the specification: a machine-readable contract outranks a test, a test outranks
 * documentation, and the README is the lowest architecture rung.
 */
export const classifyPath = (path: string): PathClassification | null => {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  const directories = new Set(segments.slice(0, -1).map((segment) => segment.toLowerCase()));
  const lowerName = name.toLowerCase();
  const extension = extensionOf(lowerName);

  if (path === FACTOREE_CONFIG_PATH) {
    return {
      authority: "repository_configuration",
      reason: "the repository configuration of SDD section 15",
      rule: "project_repository_mapping",
    };
  }

  if (extension === ".md" && ([...directories].some((d) => ADR_DIRECTORIES.has(d)) || ADR_FILE.test(lowerName))) {
    return {
      authority: "accepted_adr",
      reason: "an accepted architecture decision record",
      rule: "accepted_adr_reference",
    };
  }

  if (CONTRACT_FILES.has(lowerName) || CONTRACT_EXTENSIONS.has(extension)) {
    return {
      authority: "machine_readable_contract",
      reason: "a versioned machine-readable contract",
      rule: "declared_client_or_import",
    };
  }

  if (
    [...directories].some((directory) => TEST_DIRECTORIES.has(directory)) ||
    lowerName.includes(".test.") ||
    lowerName.includes(".spec.")
  ) {
    return {
      authority: "executable_tests",
      reason: "an executable test that shows the current behavior",
      rule: "declared_client_or_import",
    };
  }

  // Only the file at the repository root is the README of SDD section 22. A nested file is
  // ordinary documentation.
  if (segments.length === 1 && lowerName === "readme.md") {
    return {
      authority: "repository_readme",
      reason: "the repository README",
      rule: "project_repository_mapping",
    };
  }

  if (extension === ".md" && [...directories].some((directory) => DOC_DIRECTORIES.has(directory))) {
    return {
      authority: "architecture_documentation",
      reason: "repository architecture documentation",
      rule: "accepted_adr_reference",
    };
  }

  if (SOURCE_EXTENSIONS.has(extension)) {
    return {
      authority: "source_code",
      reason: "an existing implementation pattern in the primary repository",
      rule: "scoped_semantic_search",
    };
  }

  return null;
};

/** The authority classes that a path alone grants, so the project override of SDD section 22 governs them. */
const DOCUMENTATION_AUTHORITIES = new Set<AuthorityClass>(["accepted_adr", "architecture_documentation"]);

/**
 * GitHub issue 60. True when the repository declares its authoritative documentation and this
 * documentation path is not part of it. An empty declaration grants every documentation path.
 */
export const isUndeclaredDocumentation = (
  path: string,
  authority: AuthorityClass,
  authoritativePaths: readonly string[],
): boolean =>
  authoritativePaths.length > 0 &&
  DOCUMENTATION_AUTHORITIES.has(authority) &&
  !authoritativePaths.some((pattern) => posix.matchesGlob(path, pattern));

export interface RepositoryContextSourceOptions {
  reader: RepositoryReader;
}

/**
 * SDD section 17 requires a primary GitHub repository source and a reference GitHub repository
 * source. Both are the same source here, because the reader reads a repository the same way
 * whichever role it holds. SDD section 20 requires an explicit commit SHA for every reference
 * repository. SDD section 55 requires the repository, the SHA, the path, and the content hash of
 * every recorded item. Discovery therefore pins a SHA before it lists anything.
 *
 * The source runs on the control plane through a read-only git port. It executes no repository
 * code. See DI-4.2.
 */
export class RepositoryContextSource implements ContextSource {
  private readonly urls = new Map<string, string>();
  private readonly shas = new Map<string, string>();

  constructor(private readonly options: RepositoryContextSourceOptions) {}

  id(): string {
    return "repository";
  }

  /** The pinned SHA of every repository this discovery saw, by slug. */
  pinnedShas(): Record<string, string> {
    return Object.fromEntries(this.shas);
  }

  private async discoverRepository(
    repository: RepositoryRef,
    request: ContextDiscoveryRequest,
    role: "primary" | "target" | "reference",
  ): Promise<ContextCandidate[]> {
    // SDD section 20. An explicit commit SHA, never a moving ref.
    //
    // SDD section 49. A ref that does not exist, and a repository that does not exist, are
    // semantic failures of the Run configuration. They repeat on every attempt, so they must
    // drive a workflow decision instead of the infrastructure retry policy. A transport fault
    // against a reachable host is not deterministic, so it stays retryable.
    let sha: string;
    try {
      sha = await this.options.reader.resolveRef(repository.url, repository.ref);
    } catch (error) {
      if (error instanceof RepositoryReadError && error.deterministic) {
        throw new RunConfigurationError(
          `The ${role} repository "${repository.slug}" is not usable: ${error.message}`,
        );
      }
      throw error;
    }
    this.urls.set(repository.slug, repository.url);
    this.shas.set(repository.slug, sha);

    const tree = await this.options.reader.listTree(repository.url, sha);

    const repositoryReason =
      role === "primary"
        ? "the primary repository of the Project"
        : role === "target"
          ? "a target repository of the change set"
          : "a configured reference repository";
    const truncatedNote = tree.truncated
      ? ` The file listing was truncated, so this repository is only partly indexed.`
      : "";

    const candidates: ContextCandidate[] = [
      {
        reference: {
          sourceId: this.id(),
          ref: `repository:${repository.slug}`,
          repository: repository.slug,
          sha,
          path: null,
        },
        sourceVersion: sha,
        authority: "source_code",
        reason: `${repositoryReason}${truncatedNote}`,
        priority: DISCOVERY_PRIORITY.project_repository_mapping,
        topics: request.topics,
        sizeBytes: null,
        // SDD section 21. A repository is never preloaded. The Implementer reaches it by path in
        // the sandbox. AT-09 requires exactly this.
        suggestedClassification: role === "reference" ? "reference" : "required",
      },
    ];

    for (const entry of tree.entries) {
      const classification = classifyPath(entry.path);
      if (classification === null) continue;

      const topics = topicsIn(entry.path, request.topics);

      // SDD section 18 disables unbounded retrieval. A source file is offered only from the
      // primary repository, and only when the path carries a Work Item topic. A large repository
      // then never floods the contract. AT-02 needs at least one such pattern.
      if (classification.authority === "source_code") {
        // docs/specs/change-sets.md. Every target of a change set is changed, so each one offers its source.
        if (role === "reference" || topics.length === 0) continue;
      }

      // SDD section 21. Every discovered file starts as a reference item. The resolver promotes
      // it to `required` or demotes it to `discoverable` under the context budget, because only
      // the resolver knows the whole selection.
      //
      // GitHub issue 60. Documentation the primary repository's `context.authority` leaves out
      // stays reachable by path, and never enters a conflict. The file names only the primary
      // repository's own paths, so a target or a reference repository keeps the plain rule.
      const undeclared =
        role === "primary" &&
        isUndeclaredDocumentation(entry.path, classification.authority, request.contextConfiguration.authoritativePaths);
      const suggested: ContextClassification = undeclared ? "discoverable" : "reference";
      const reason = undeclared
        ? `${classification.reason}, left out of context.authority, so it is reference only and decides nothing`
        : classification.reason;

      candidates.push({
        reference: {
          sourceId: this.id(),
          ref: `repository:${repository.slug}:${entry.path}`,
          repository: repository.slug,
          sha,
          path: entry.path,
        },
        sourceVersion: sha,
        authority: classification.authority,
        reason,
        priority: DISCOVERY_PRIORITY[classification.rule],
        topics,
        sizeBytes: entry.sizeBytes,
        suggestedClassification: suggested,
      });
    }

    return candidates;
  }

  async discover(request: ContextDiscoveryRequest): Promise<ContextCandidate[]> {
    // The two maps are not cleared here. The resolver calls this source again for each
    // automatically discovered repository, and `fetch` must still reach a repository an earlier
    // pass pinned. Both maps are keyed by slug, so a repeated pass overwrites its own entry.
    const primary = await this.discoverRepository(request.primaryRepository, request, "primary");
    for (const repository of request.targetRepositories ?? []) {
      primary.push(...(await this.discoverRepository(repository, request, "target")));
    }
    const references: ContextCandidate[] = [];
    for (const repository of request.referenceRepositories) {
      references.push(...(await this.discoverRepository(repository, request, "reference")));
    }
    return [...primary, ...references];
  }

  async fetch(ref: ContextReference): Promise<ContextDocument> {
    const slug = ref.repository;
    const url = slug === null ? undefined : this.urls.get(slug);
    if (slug === null || url === undefined || ref.sha === null || ref.path === null) {
      throw new RepositoryReadError(`"${ref.ref}" is not a readable repository path.`);
    }
    const content = await this.options.reader.readBlob(url, ref.sha, ref.path);
    if (content === null) {
      throw new RepositoryReadError(
        `the blob "${ref.path}" of ${slug} at ${ref.sha} is absent or too large to read.`,
      );
    }
    return { reference: ref, sourceVersion: ref.sha, content };
  }
}
