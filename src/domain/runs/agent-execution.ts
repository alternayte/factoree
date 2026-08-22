import type { AgentRole } from "./agent-runner.js";

export interface RecordAgentExecutionInput {
  tenantId: string;
  runId: string;
  role: AgentRole;
  runner: string;
  model: string | null;
  sessionRef: string | null;
  promptVersion: string;
  durationMs: number;
  /**
   * A small, redacted result record. SDD section 61 forbids persisting the full transcript by
   * default, so this carries the outcome and the redacted summary only.
   */
  finalResult: { completed: boolean; exitCode: number; cancelled: boolean; summary: string };
}

export interface AgentExecutionRecord extends RecordAgentExecutionInput {
  id: string;
  createdAt: Date;
}

export interface AgentExecutionRepository {
  record(input: RecordAgentExecutionInput): Promise<AgentExecutionRecord>;
  listForRun(tenantId: string, runId: string): Promise<AgentExecutionRecord[]>;
}
