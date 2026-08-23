import type { RecordedDecision } from "~/domain/refinement/refinement-engine.js";
import type { AuthorityClass } from "./authority.js";

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
