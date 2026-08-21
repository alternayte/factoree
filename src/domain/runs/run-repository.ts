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

export interface RunRepository {
  createIfAbsent(input: CreateRunInput): Promise<{ run: RunRecord; created: boolean }>;
  findById(tenantId: string, id: string): Promise<RunRecord | null>;
  findByAgentSession(tenantId: string, agentSessionId: string): Promise<RunRecord | null>;
  updateStatus(id: string, status: RunStatus, patch?: RunStatusPatch): Promise<RunRecord>;
}

export interface WebhookLog {
  recordIfNew(input: { tenantId: string | null; deliveryId: string; eventType: string }): Promise<boolean>;
}
