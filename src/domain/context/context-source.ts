import type { RecordedDecision } from "~/domain/refinement/refinement-engine.js";
import type { AuthorityClass } from "./authority.js";
import type { RepositoryContextConfiguration } from "./repository-context-configuration.js";
import type { WorkItemImage, WorkItemLink } from "./work-item-content.js";

/**
 * docs/specs/work-item-images-and-links.md. What Factoree read of the issue at delegation besides
 * its description: the kept human comments, the kept images and the followed links. Only the
 * comments carry their text. An image and a link carry their hash.
 */
export interface WorkItemContextContent {
  comments: string | null;
  images: WorkItemImage[];
  links: WorkItemLink[];
}

/** SDD section 21. Required items can enter initial role context. */
export const CONTEXT_CLASSIFICATIONS = ["required", "reference", "discoverable"] as const;

export type ContextClassification = (typeof CONTEXT_CLASSIFICATIONS)[number];

/** SDD section 18. The discovery priority, highest first. A lower number ranks higher. */
export const DISCOVERY_PRIORITY = {
  work_item_reference: 1,
  project_repository_mapping: 2,
  backstage_relation: 3,
  backstage_api_relation: 4,
  work_item_repository_name: 5,
  accepted_adr_reference: 6,
  declared_client_or_import: 7,
  scoped_semantic_search: 8,
} as const;

export type DiscoveryRule = keyof typeof DISCOVERY_PRIORITY;

export interface RepositoryRef {
  /** The `owner/repo` slug. */
  slug: string;
  /** The clone URL. */
  url: string;
  /** The requested ref. Discovery replaces it with an explicit SHA. */
  ref: string;
}

export interface ContextDiscoveryRequest {
  runId: string;
  goal: string;
  /** The deterministic keyword set of the Work Item. See `topicsOf`. */
  topics: string[];
  primaryRepository: RepositoryRef;
  referenceRepositories: RepositoryRef[];
  /** Every reference the Work Item declared, as written. */
  workItemReferences: string[];
  /** SDD section 23. Every human answer recorded on this Run so far. */
  decisions: RecordedDecision[];
  /** SDD section 15. The `context` block of the primary repository, at the pinned SHA. */
  contextConfiguration: RepositoryContextConfiguration;
  /** docs/specs/work-item-images-and-links.md. Absent for a run that read none. */
  workItemContent?: WorkItemContextContent;
}

/**
 * SDD section 21 requires a stable reference. `ref` is that reference and is unique inside one
 * contract. `repository`, `sha`, and `path` carry the SDD section 55 fields for a repository
 * item, and are null for an item that is not repository content.
 */
export interface ContextReference {
  sourceId: string;
  ref: string;
  repository: string | null;
  sha: string | null;
  path: string | null;
}

export interface ContextCandidate {
  reference: ContextReference;
  /** SDD section 21 and section 55. A commit SHA, a timestamp, or another stable version. */
  sourceVersion: string;
  authority: AuthorityClass;
  /** SDD section 21 requires a selection reason a human can read. */
  reason: string;
  /** The SDD section 18 priority of the rule that found this candidate. */
  priority: number;
  /** The Work Item topics this candidate carries. The rank rule and conflict detection both use it. */
  topics: string[];
  /** The size of the content, when the source knows it without a fetch. */
  sizeBytes: number | null;
  suggestedClassification: ContextClassification;
  /**
   * SDD section 20. A source that learns of a repository Factoree does not yet read reports it
   * here. The resolver decides whether it becomes a reference repository of the Run.
   */
  discoveredRepository?: { slug: string; url: string };
  /**
   * docs/specs/work-item-images-and-links.md. The SHA-256 of content the source already read and
   * does not hold, such as the bytes of an image or a followed link. The resolver freezes it and
   * fetches nothing (DI-21.43).
   */
  contentSha256?: string;
  /**
   * DI-21.43. A required item that reaches the agent as a file, not as prompt text. It stays
   * required and does not count against the preload budget of SDD section 21.
   */
  outsideBudget?: boolean;
}

export interface ContextDocument {
  reference: ContextReference;
  sourceVersion: string;
  content: string;
}

/** SDD section 17. Every context source implements exactly this interface. */
export interface ContextSource {
  id(): string;
  discover(request: ContextDiscoveryRequest): Promise<ContextCandidate[]>;
  fetch(ref: ContextReference): Promise<ContextDocument>;
}
