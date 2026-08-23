import type {
  ContextContractStore,
  SaveContextContractInput,
  StoredContextContract,
} from "~/domain/context/context-contract-store.js";

export class FakeContextContractStore implements ContextContractStore {
  private readonly byRun = new Map<string, StoredContextContract>();
  private sequence = 0;

  save(input: SaveContextContractInput): Promise<StoredContextContract> {
    // SDD section 21. The contract is immutable, so an existing one wins and nothing changes.
    const existing = this.byRun.get(input.runId);
    if (existing !== undefined) return Promise.resolve(existing);
    this.sequence += 1;
    const stored: StoredContextContract = {
      id: `ctx-${this.sequence}`,
      tenantId: input.tenantId,
      runId: input.runId,
      version: input.contract.version,
      sha256: input.sha256,
      document: input.document,
      items: [...input.contract.items],
      conflicts: [...input.contract.conflicts],
      createdAt: new Date(0),
    };
    this.byRun.set(input.runId, stored);
    return Promise.resolve(stored);
  }

  findByRun(tenantId: string, runId: string): Promise<StoredContextContract | null> {
    const stored = this.byRun.get(runId);
    // SDD section 52. A read must not cross the tenant boundary.
    return Promise.resolve(stored?.tenantId === tenantId ? stored : null);
  }

  all(): StoredContextContract[] {
    return [...this.byRun.values()];
  }
}
