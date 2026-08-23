import type { RepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { RepositoryReadError } from "~/adapters/github/git-repository-reader.js";
import { FACTOREE_CONFIG_PATH } from "~/domain/projects/factoree-config.js";
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

const topicsIn = (path: string, topics: string[]): string[] => {
  const lower = path.toLowerCase();
  return topics.filter((topic) => lower.includes(topic));
};

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
 * code. See controller decision 2.
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
    role: "primary" | "reference",
  ): Promise<ContextCandidate[]> {
    // SDD section 20. An explicit commit SHA, never a moving ref.
    const sha = await this.options.reader.resolveRef(repository.url, repository.ref);
    this.urls.set(repository.slug, repository.url);
    this.shas.set(repository.slug, sha);

    const tree = await this.options.reader.listTree(repository.url, sha);

    const repositoryReason =
      role === "primary" ? "the primary repository of the Project" : "a configured reference repository";
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
        suggestedClassification: role === "primary" ? "required" : "reference",
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
        if (role !== "primary" || topics.length === 0) continue;
      }

      // SDD section 21. Every discovered file starts as a reference item. The resolver promotes
      // it to `required` or demotes it to `discoverable` under the context budget, because only
      // the resolver knows the whole selection.
      const suggested: ContextClassification = "reference";

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
        reason: classification.reason,
        priority: DISCOVERY_PRIORITY[classification.rule],
        topics,
        sizeBytes: entry.sizeBytes,
        suggestedClassification: suggested,
      });
    }

    return candidates;
  }

  async discover(request: ContextDiscoveryRequest): Promise<ContextCandidate[]> {
    this.urls.clear();
    this.shas.clear();
    const primary = await this.discoverRepository(request.primaryRepository, request, "primary");
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
