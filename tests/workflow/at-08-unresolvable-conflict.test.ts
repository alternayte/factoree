import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { humanInputSignal, stopSignal } from "~/workflows/agent-run.workflow.js";
import { MAX_QUESTION_ROUNDS } from "~/workflows/agent-run.workflow.js";
import { conflictQuestion } from "~/domain/context/conflicts.js";
import { createWorkflowHarness, waitFor, waitForStatus } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  completions,
  implementCalls,
  prepared,
  elicitations,
  contextConflicts,
  runStatusQuery,
  PRIMARY_SHA,
  start,
  runWorker,
} = harness;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
});

/**
 * Two accepted ADRs carry one Work Item topic, and no authority ladder separates them. This is
 * the record `detectConflicts` produces for that pair. `tests/unit/context-conflicts.test.ts`
 * proves the detection rule and the human-decision rule against the real domain.
 */
const adrConflict = {
  id: "CTX-1",
  subject: "notification",
  domain: "architecture_intent" as const,
  question: conflictQuestion({
    id: "CTX-1",
    subject: "notification",
    authorityDomain: "architecture_intent",
    winnerRef: null,
    loserRef: null,
    reason:
      '"docs/ADR-031.md" and "docs/ADR-042.md" are equally authoritative accepted ADR sources ' +
      'for "notification"',
    resolution: "unresolved",
  }),
};

const implementsOf = (runId: string) => implementCalls.filter((entry) => entry.runId === runId);
const completionsOf = (runId: string) => completions.filter((entry) => entry.runId === runId);
const preparedOf = (runId: string) => prepared.filter((entry) => entry.runId === runId);

describe("AT-08 — an unresolvable conflict stops the Run and asks one question", () => {
  it("holds the Run in WAITING_FOR_INPUT and prepares no sandbox", async () => {
    contextConflicts.set("run-ses-at08a", [adrConflict]);
    await runWorker(async () => {
      const handle = await start("ses-at08a");
      await waitForStatus(handle, "WAITING_FOR_INPUT");

      const snapshot = await handle.query(runStatusQuery);
      expect(snapshot.openQuestion).toMatch(/ADR-031/);
      expect(snapshot.openQuestion).toMatch(/ADR-042/);
      // SDD section 21. Factoree froze no contract, so the Run reports no contract version. A
      // plausible hash here matches no stored contract and no database column.
      expect(snapshot.contextContractVersion).toBeNull();
      // SDD section 23. Implementation must not start, so no sandbox exists yet.
      expect(preparedOf("run-ses-at08a")).toEqual([]);
      expect(implementsOf("run-ses-at08a")).toEqual([]);

      await handle.signal(stopSignal);
      const result = await handle.result();
      expect(result.status).toBe("CANCELLED");
    });
    contextConflicts.delete("run-ses-at08a");
  });

  it("reaches PREPARING once a human decision settles the subject", async () => {
    contextConflicts.set("run-ses-at08b", [adrConflict]);
    await runWorker(async () => {
      const handle = await start("ses-at08b");
      await waitForStatus(handle, "WAITING_FOR_INPUT");
      await handle.signal(humanInputSignal, "ADR-042 governs the notification channel.");
      // The Implementer starts, so the conflict is settled and the sandbox exists.
      await waitFor(() => implementsOf("run-ses-at08b").length === 1, "the Implementer of at08b");

      // SDD section 20. The checkout landed on the SHA discovery pinned, not on a moving ref.
      expect(preparedOf("run-ses-at08b")[0]?.primary.ref).toBe(PRIMARY_SHA);
      // The contract is frozen now, so the Run reports its version.
      const settledSnapshot = await handle.query(runStatusQuery);
      expect(settledSnapshot.contextContractVersion).toMatch(/^[0-9a-f]{64}$/);
      // AT-09. The prompt carries the rendered contract and the required-context lines only.
      const call = implementsOf("run-ses-at08b")[0];
      expect(call?.contextContract).toContain("# Context Contract");
      expect(call?.requiredContext).toEqual([expect.stringContaining("run-ses-at08b")]);

      await handle.signal(stopSignal);
      await handle.result();
    });
    contextConflicts.delete("run-ses-at08b");
  });

  /**
   * The same subject raises a second conflict in the interface contract domain. SDD section 23
   * requires a focused question for each of them, so one answer must not settle both.
   */
  const contractConflict = {
    id: "CTX-2",
    subject: "notification",
    domain: "interface_contract" as const,
    question: conflictQuestion({
      id: "CTX-2",
      subject: "notification",
      authorityDomain: "interface_contract",
      winnerRef: null,
      loserRef: null,
      reason:
        '"api/openapi.yaml" and "api/events.proto" are equally authoritative versioned ' +
        'machine-readable contract sources for "notification"',
      resolution: "unresolved",
    }),
  };

  it("asks the second domain question instead of a start of implementation", async () => {
    contextConflicts.set("run-ses-at08d", [adrConflict, contractConflict]);
    const before = elicitations.length;
    await runWorker(async () => {
      const handle = await start("ses-at08d");
      await waitFor(() => elicitations.length === before + 1, "the first question of at08d");
      expect(elicitations[before]).toMatch(/ADR-031/);

      await handle.signal(humanInputSignal, "ADR-042 governs the notification channel.");

      // The answer settled the architecture domain only, so Factoree asks the interface
      // question and the Run waits again.
      await waitFor(() => elicitations.length === before + 2, "the second question of at08d");
      expect(elicitations[before + 1]).toMatch(/openapi\.yaml/);
      await waitForStatus(handle, "WAITING_FOR_INPUT");
      const snapshot = await handle.query(runStatusQuery);
      expect(snapshot.status).toBe("WAITING_FOR_INPUT");
      expect(snapshot.contextContractVersion).toBeNull();
      expect(preparedOf("run-ses-at08d")).toEqual([]);
      expect(implementsOf("run-ses-at08d")).toEqual([]);

      await handle.signal(stopSignal);
      const result = await handle.result();
      expect(result.status).toBe("CANCELLED");
    });
    contextConflicts.delete("run-ses-at08d");
  });

  it("reaches PREPARING once both domain questions carry an answer", async () => {
    contextConflicts.set("run-ses-at08e", [adrConflict, contractConflict]);
    const before = elicitations.length;
    await runWorker(async () => {
      const handle = await start("ses-at08e");
      await waitFor(() => elicitations.length === before + 1, "the first question of at08e");
      await handle.signal(humanInputSignal, "ADR-042 governs the notification channel.");
      await waitFor(() => elicitations.length === before + 2, "the second question of at08e");
      await handle.signal(humanInputSignal, "The OpenAPI document governs the payload.");

      await waitFor(() => implementsOf("run-ses-at08e").length === 1, "the Implementer of at08e");
      await handle.signal(stopSignal);
      await handle.result();
    });
    contextConflicts.delete("run-ses-at08e");
  });

  it("fails the Run with CONTEXT_UNRESOLVED when the rounds are spent", async () => {
    // No answer settles this conflict, so every resolution reports it again. The bounded
    // rounds must end the Run.
    contextConflicts.set("run-ses-at08c", [{ ...adrConflict, settledByDecision: false }]);
    const before = elicitations.length;

    const result = await runWorker(async () => {
      const handle = await start("ses-at08c");
      for (let round = 0; round < MAX_QUESTION_ROUNDS; round += 1) {
        await waitFor(() => elicitations.length === before + round + 1, `question ${round + 1}`);
        await handle.signal(humanInputSignal, `answer ${round}`);
      }
      return handle.result();
    });
    contextConflicts.delete("run-ses-at08c");

    expect(elicitations.length - before).toBe(MAX_QUESTION_ROUNDS);
    expect(result.status).toBe("FAILED");
    expect(completionsOf("run-ses-at08c").at(-1)?.failureReason).toBe("CONTEXT_UNRESOLVED");
    expect(implementsOf("run-ses-at08c")).toEqual([]);
  });
});
