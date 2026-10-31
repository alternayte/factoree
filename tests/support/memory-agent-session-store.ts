import type {
  AgentSessionRecord,
  AgentSessionStore,
  RecordAgentSessionInput,
} from "~/domain/runs/agent-session.js";

/**
 * An in-memory `AgentSessionStore` for a unit test. It upserts on the idempotency key, the same
 * way `PrismaAgentSessionStore` does.
 */
export class MemoryAgentSessionStore implements AgentSessionStore {
  readonly rows: AgentSessionRecord[] = [];

  record(input: RecordAgentSessionInput): Promise<AgentSessionRecord> {
    const existing = this.rows.find(
      (row) => row.tenantId === input.tenantId && row.idempotencyKey === input.idempotencyKey,
    );
    if (existing !== undefined) return Promise.resolve(existing);
    const row: AgentSessionRecord = { ...input, id: `session-${this.rows.length + 1}`, createdAt: new Date() };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  listForRun(tenantId: string, runId: string): Promise<AgentSessionRecord[]> {
    return Promise.resolve(this.rows.filter((row) => row.tenantId === tenantId && row.runId === runId));
  }
}
