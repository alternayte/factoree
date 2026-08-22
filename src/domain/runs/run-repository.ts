import type { RunFailureReason, RunStatus } from "./run-status.js";

export interface RunRecord {
  id: string;
  tenantId: string;
  projectId: string;
  linearIssueId: string | null;
  linearAgentSessionId: string;
  temporalWorkflowId: string;
  status: RunStatus;
  failureReason: RunFailureReason | null;
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
  /** Records the sandbox of the Run and the moment its retention window ends. */
  setSandbox(tenantId: string, runId: string, sandbox: RunSandboxPatch): Promise<void>;
  /** Removes the sandbox reference after the sandbox is deleted. The evidence stays. */
  clearSandbox(tenantId: string, runId: string): Promise<void>;
  /** Runs whose sandbox retention window has passed and whose sandbox still exists. */
  listExpiredSandboxes(now: Date, limit: number): Promise<ExpiredSandboxRun[]>;
}

export interface WebhookLog {
  recordIfNew(input: { tenantId: string | null; deliveryId: string; eventType: string }): Promise<boolean>;
  // Releases a marker recorded by recordIfNew, so that a failed delegation can be redelivered.
  remove(deliveryId: string): Promise<void>;
}
