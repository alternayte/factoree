import { describe, expect, it, vi } from "vitest";
import { createValidationActivities } from "~/activities/validation.activities.js";
import type { ValidationContractStore } from "~/domain/validation/validation-contract-store.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const storeStub = (): ValidationContractStore & { saved: unknown[] } => {
  const saved: unknown[] = [];
  let stored: Awaited<ReturnType<ValidationContractStore["save"]>> | null = null;
  return {
    saved,
    save(input) {
      if (stored !== null) return Promise.resolve(stored);
      saved.push(input);
      stored = {
        id: "vc-1",
        tenantId: input.tenantId,
        runId: input.runId,
        version: input.contract.version,
        sha256: input.sha256,
        workItem: input.contract.workItem,
        goal: input.contract.goal,
        document: input.document,
        assertions: input.contract.assertions.map((assertion, index) => ({
          ...assertion,
          rowId: `assertion-row-${index}`,
        })),
        createdAt: new Date("2026-08-25T10:00:00.000Z"),
      };
      return Promise.resolve(stored);
    },
    findByRun() {
      return Promise.resolve(stored);
    },
  };
};

const runsStub = () => ({
  setValidationContractVersion: vi.fn(() => Promise.resolve(undefined)),
});

const input = () => ({
  runId: "run-1",
  tenantId: "tenant-1",
  productId: "project-1",
  workItem: "ENG-143",
  goal: "A signed-in editor can rename a project.",
  acceptanceCriteria: [
    { id: "AC-1", statement: "PATCH /projects/{id} returns 403 for a user without edit permission.", source: "work-item" },
  ],
  humanAssertions: [],
});

describe("buildValidationContract activity", () => {
  it("freezes the contract, records its hash on the Run, and reports it ready", async () => {
    const contracts = storeStub();
    const runs = runsStub();
    const activities = createValidationActivities({ contracts, runs: runs as never, logger: logger as never });

    const output = await activities.buildValidationContract(input());

    expect(output.status).toBe("ready");
    expect(output.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(output.assertionCount).toBe(1);
    expect(output.frozenAt).toBe("2026-08-25T10:00:00.000Z");
    expect(runs.setValidationContractVersion).toHaveBeenCalledWith("tenant-1", "run-1", output.sha256);
    expect(contracts.saved).toHaveLength(1);
  });

  it("writes no second contract on a retry, because SDD section 25 forbids a change", async () => {
    const contracts = storeStub();
    const runs = runsStub();
    const activities = createValidationActivities({ contracts, runs: runs as never, logger: logger as never });

    const first = await activities.buildValidationContract(input());
    const second = await activities.buildValidationContract(input());

    expect(second.sha256).toBe(first.sha256);
    expect(contracts.saved).toHaveLength(1);
    expect(runs.setValidationContractVersion).toHaveBeenLastCalledWith(
      "tenant-1",
      "run-1",
      first.sha256,
    );
  });

  it("repairs a Run row an interrupted attempt left without the hash", async () => {
    // This reproduces the bug directly: the first call freezes the contract but the Run write
    // fails, so `Run.validationContractVersion` stays null. A retry must still repair the Run row,
    // through the early-return path, and it must not write a second contract.
    const contracts = storeStub();
    const runs = runsStub();
    runs.setValidationContractVersion.mockImplementationOnce(() =>
      Promise.reject(new Error("transient write failure")),
    );
    const activities = createValidationActivities({ contracts, runs: runs as never, logger: logger as never });

    await expect(activities.buildValidationContract(input())).rejects.toThrow(
      "transient write failure",
    );
    expect(contracts.saved).toHaveLength(1);

    const second = await activities.buildValidationContract(input());

    expect(contracts.saved).toHaveLength(1);
    expect(runs.setValidationContractVersion).toHaveBeenLastCalledWith(
      "tenant-1",
      "run-1",
      second.sha256,
    );
  });

  it("returns the frozen contract, not a freshly built one, when the two would differ", async () => {
    const contracts = storeStub();
    const runs = runsStub();
    const activities = createValidationActivities({ contracts, runs: runs as never, logger: logger as never });

    const first = await activities.buildValidationContract(input());
    const second = await activities.buildValidationContract({
      ...input(),
      acceptanceCriteria: [
        ...input().acceptanceCriteria,
        { id: "AC-2", statement: "The rename button is visible on the project page.", source: "work-item" },
      ],
    });

    expect(second.sha256).toBe(first.sha256);
    expect(second.assertionCount).toBe(1);
  });

  it("asks one focused question and freezes nothing when no observable assertion exists", async () => {
    const contracts = storeStub();
    const runs = runsStub();
    const activities = createValidationActivities({ contracts, runs: runs as never, logger: logger as never });

    const output = await activities.buildValidationContract({ ...input(), acceptanceCriteria: [] });

    expect(output.status).toBe("needs_input");
    expect(output.sha256).toBeNull();
    expect(output.question?.id).toBe("VAL-Q-1");
    expect(contracts.saved).toHaveLength(0);
    expect(runs.setValidationContractVersion).not.toHaveBeenCalled();
  });

  it("freezes a contract built from a human answer", async () => {
    const contracts = storeStub();
    const runs = runsStub();
    const activities = createValidationActivities({ contracts, runs: runs as never, logger: logger as never });

    const output = await activities.buildValidationContract({
      ...input(),
      acceptanceCriteria: [],
      humanAssertions: ["The rename button is disabled for a viewer."],
    });

    expect(output.status).toBe("ready");
    expect(output.assertionCount).toBe(1);
  });
});
