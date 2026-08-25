import type { RunFailureReason, RunStatus } from "./run-status.js";
import type { RunFailureCategory } from "./failure-category.js";

export interface RunRecord {
  id: string;
  tenantId: string;
  projectId: string;
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
  projectId: string;
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
}

export interface WebhookLog {
  recordIfNew(input: { tenantId: string | null; deliveryId: string; eventType: string }): Promise<boolean>;
  // Releases a marker recorded by recordIfNew, so that a failed delegation can be redelivered.
  remove(deliveryId: string): Promise<void>;
}
