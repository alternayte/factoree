import type { RunFailureReason, RunStatus } from "./run-status.js";
import type { RunFailureCategory } from "./failure-category.js";

export interface RunRecord {
  id: string;
  tenantId: string;
  productId: string;
  linearIssueId: string | null;
  linearAgentSessionId: string;
  temporalWorkflowId: string;
  status: RunStatus;
  failureReason: RunFailureReason | null;
  failureCategory: RunFailureCategory | null;
  autonomyLevel: string;
  implementerRunner: string | null;
  validatorRunner: string | null;
  reviewerRunner: string | null;
  spriteId: string | null;
  spriteAdapter: string | null;
  spriteRetainUntil: Date | null;
  baseSha: string | null;
  patchSha256: string | null;
  commitSha: string | null;
  pullRequestUrl: string | null;
  contextContractVersion: string | null;
  validationContractVersion: string | null;
  /**
   * SDD section 55. The commit the organization skills checkout resolved to. It is null when the
   * Project configures no organization skills repository, or the Run recorded no sandbox yet.
   */
  organizationSkillsSha: string | null;
  /** Specification section 8. The SHA-256 of the identity file at the Run's base commit. */
  configSha: string | null;
  /** SDD section 47. The SHA-256 of the Proof Pack this Run posted, or null while none exists. */
  proofPackSha256: string | null;
  proofPackPostedAt: Date | null;
  repairCount: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface CreateRunInput {
  tenantId: string;
  productId: string;
  linearIssueId: string | null;
  linearAgentSessionId: string;
  temporalWorkflowId: string;
  autonomyLevel: string;
}

export interface RunStatusPatch {
  failureReason?: RunFailureReason;
  /**
   * SDD section 67. The normalized category of the failure reason. The activity derives it,
   * so no caller can record a category that disagrees with the reason.
   */
  failureCategory?: RunFailureCategory;
  startedAt?: Date;
  completedAt?: Date;
  repairCount?: number;
}

export interface RunSandboxPatch {
  spriteId: string;
  adapter: string;
  retainUntil: Date;
  baseSha: string;
  implementerRunner: string;
  /**
   * SDD section 55. The commit the organization skills checkout resolved to. Absent when the
   * Project configures no organization skills repository.
   */
  organizationSkillsSha?: string;
}

/**
 * The sandbox the Run held before `setSandbox` replaced it. The caller deletes it, because
 * nothing refers to it any more. Both fields are null when the Run held no sandbox.
 */
export interface SupersededSandbox {
  spriteId: string | null;
  adapter: string | null;
}

/** One Run whose sandbox retention window has passed and whose sandbox still exists. */
export interface ExpiredSandboxRun {
  tenantId: string;
  runId: string;
  spriteId: string;
  adapter: string;
}

/** Specification section 10. The write `recordRunTarget` sends to the `RunTarget` row. */
export interface CreateRunTargetInput {
  tenantId: string;
  runId: string;
  repositoryId: string;
  selectionReason: string;
}

/** Specification section 5. One `RunTarget` row, with the per-target facts section 14 defines. */
export interface RunTargetRecord {
  id: string;
  tenantId: string;
  runId: string;
  repositoryId: string;
  selectionReason: string;
  baseSha: string | null;
  patchSha256: string | null;
  commitSha: string | null;
  pullRequestUrl: string | null;
}

/**
 * Specification section 14. The per-target facts recorded as each becomes known: the base SHA
 * after context resolution, the patch hash and commit SHA after publication, and the pull
 * request URL after the pull request exists. A caller sends only the fields it has learned.
 */
export interface RunTargetPatch {
  baseSha?: string;
  patchSha256?: string;
  commitSha?: string;
  pullRequestUrl?: string;
}

export interface RunRepository {
  createIfAbsent(input: CreateRunInput): Promise<{ run: RunRecord; created: boolean }>;
  findById(tenantId: string, id: string): Promise<RunRecord | null>;
  findByAgentSession(tenantId: string, agentSessionId: string): Promise<RunRecord | null>;
  updateStatus(id: string, status: RunStatus, patch?: RunStatusPatch): Promise<RunRecord>;
  /**
   * Records the sandbox of the Run and the moment its retention window ends. It reports the
   * sandbox it replaced in the same atomic step, so two concurrent attempts cannot both believe
   * they replaced the same one.
   */
  setSandbox(tenantId: string, runId: string, sandbox: RunSandboxPatch): Promise<SupersededSandbox>;
  /** Removes the sandbox reference after the sandbox is deleted. The evidence stays. */
  clearSandbox(tenantId: string, runId: string): Promise<void>;
  /**
   * SDD section 53. `Run.contextContractVersion` holds the SHA-256 of the frozen contract, because
   * that value names the exact contract the Run uses. The method throws when it reaches no Run of
   * that tenant, because a silent success hides a caller defect.
   */
  setContextContractVersion(tenantId: string, runId: string, version: string): Promise<void>;
  /**
   * SDD section 53. `Run.validationContractVersion` holds the SHA-256 of the frozen Validation
   * Contract, because that value names the exact contract the Run must satisfy. See controller
   * decision 5. The method throws when it reaches no Run of that tenant, because a silent success
   * hides a caller defect.
   */
  setValidationContractVersion(tenantId: string, runId: string, version: string): Promise<void>;
  /**
   * SDD section 44 and section 46. Records the immutable publication facts of one Run. The method
   * throws when it reaches no Run of that tenant, because a silent success hides a caller defect.
   */
  setPublication(
    tenantId: string,
    runId: string,
    publication: { patchSha256: string; commitSha: string; pullRequestUrl: string },
  ): Promise<void>;
  /**
   * SDD section 47 and section 68. Records the Proof Pack of one Run. The method throws when it
   * reaches no Run of that tenant, because a silent success hides a caller defect.
   */
  setProofPack(
    tenantId: string,
    runId: string,
    proofPack: { sha256: string; postedAt: Date },
  ): Promise<void>;
  /**
   * SDD section 28. Refinement caps the autonomy level of the Run. `createRun` happens before
   * Refinement, so the Run row first holds the Project default. This method writes the capped
   * level. The method throws when it reaches no Run of that tenant, because a silent success
   * hides a caller defect.
   */
  setAutonomyLevel(tenantId: string, runId: string, level: string): Promise<void>;
  /** Runs whose sandbox retention window has passed and whose sandbox still exists. */
  listExpiredSandboxes(now: Date, limit: number): Promise<ExpiredSandboxRun[]>;
  /**
   * Specification section 10. Records the repository target of the Run. A Version 1 Run has one
   * target, so it writes one row. Change Sets are Version 2.
   */
  createRunTarget(input: CreateRunTargetInput): Promise<{ id: string }>;
  /**
   * Specification section 14. Records the per-target facts of one `RunTarget` as they become
   * known. The method throws when it reaches no `RunTarget` of that Run and repository in that
   * tenant, because a silent success hides a caller defect.
   */
  updateRunTarget(
    tenantId: string,
    runId: string,
    repositoryId: string,
    patch: RunTargetPatch,
  ): Promise<void>;
  /** Specification section 18. The `RunTarget` rows of one Run, in merge order. */
  listRunTargets(tenantId: string, runId: string): Promise<RunTargetRecord[]>;
  /**
   * Specification section 8. Records the SHA-256 of `.factoree/config.yaml` as read at the
   * Run's base commit. The method throws when it reaches no Run of that tenant, because a
   * silent success hides a caller defect.
   */
  setConfigSha(tenantId: string, runId: string, sha: string): Promise<void>;
  /**
   * F6. The count of Runs a Product owns, so an operator's DELETE /admin/products/:id can
   * refuse to destroy the Run history and the Proof Pack evidence a cascade would otherwise
   * take with it. `Run.productId` carries `onDelete: Cascade`, so this count is exactly what
   * would be lost.
   */
  countByProduct(tenantId: string, productId: string): Promise<number>;
}

export interface WebhookLog {
  recordIfNew(input: { tenantId: string | null; deliveryId: string; eventType: string }): Promise<boolean>;
  // Releases a marker recorded by recordIfNew, so that a failed delegation can be redelivered.
  remove(deliveryId: string): Promise<void>;
}
