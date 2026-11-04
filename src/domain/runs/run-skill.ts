import type { DeliveredSkill } from "./sandbox-manager.js";
import type { SkillSourceScope } from "./skill-registry.js";

/** docs/specs/skill-registry.md. One skill a run received, as SDD section 55 records it. */
export interface RunSkill extends DeliveredSkill {
  activated: boolean;
}

/** The registry resolution a run used. */
export interface RunSkillResolution {
  set: string | null;
  id: string;
}

/** docs/specs/skill-registry.md. One skill proposal of a run, and what its source answered. */
export interface RunSkillProposal {
  name: string;
  source: SkillSourceScope;
  state: "submitted" | "refused" | "failed";
  /** The id or the pull request number the source gave, or null. */
  reference: string | null;
  /** Where a person reviews the proposal, or null. */
  url: string | null;
  /** Why the source refused it, or why the send failed. Null for a submitted proposal. */
  reason: string | null;
}

export interface RunSkillStore {
  /**
   * Replaces the skills of the run and records its resolution. A retried preparation makes a new
   * sandbox, and its skills replace the old ones.
   */
  replace(tenantId: string, runId: string, skills: DeliveredSkill[], resolution: RunSkillResolution | null): Promise<void>;
  list(tenantId: string, runId: string): Promise<RunSkill[]>;
  resolutionOf(tenantId: string, runId: string): Promise<RunSkillResolution | null>;
  /** Marks the named skills activated. A name that is already activated stays so. */
  markActivated(tenantId: string, runId: string, paths: string[]): Promise<void>;
  recordProposal(tenantId: string, runId: string, proposal: RunSkillProposal): Promise<void>;
  listProposals(tenantId: string, runId: string): Promise<RunSkillProposal[]>;
}
