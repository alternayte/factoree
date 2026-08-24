import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { humanInputSignal, stopSignal } from "~/workflows/agent-run.workflow.js";
import { MAX_QUESTION_ROUNDS } from "~/workflows/agent-run.workflow.js";
import type { BuildValidationContractActivityOutput } from "~/activities/validation.activities.js";
import {
  VALIDATION_DOCUMENT,
  VALIDATION_SHA,
  createWorkflowHarness,
  hold,
  waitFor,
  waitForStatus,
} from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  activityOrder,
  completions,
  elicitations,
  heldValidations,
  implementCalls,
  prepared,
  runStatusQuery,
  start,
  statusesOf,
  runWorker,
  validationCalls,
  validationOutcomes,
} = harness;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
});

const implementsOf = (runId: string) => implementCalls.filter((entry) => entry.runId === runId);
const completionsOf = (runId: string) => completions.filter((entry) => entry.runId === runId);
const preparedOf = (runId: string) => prepared.filter((entry) => entry.runId === runId);
const validationsOf = (runId: string) => validationCalls.filter((entry) => entry.runId === runId);

/** The result the double reports while the readiness gate of SDD section 9 item 5 fails. */
const NEEDS_INPUT: BuildValidationContractActivityOutput = {
  status: "needs_input",
  sha256: null,
  document: "# Validation Contract\n\nNo assertion exists yet.\n",
  assertionCount: 0,
  frozenAt: null,
  question: { id: "VAL-Q-1", question: "What observable behavior proves this work is done?" },
  summary: "Factoree cannot define success for this Work Item.",
};

/** The result the double reports once one assertion exists and the contract froze. */
const READY: BuildValidationContractActivityOutput = {
  status: "ready",
  sha256: VALIDATION_SHA,
  document: VALIDATION_DOCUMENT,
  assertionCount: 1,
  frozenAt: "2026-01-01T00:00:00.000Z",
  question: null,
  summary: "Factoree froze the Validation Contract with 1 assertion.",
};

describe("the Validation Contract state of the Run workflow", () => {
  it("freezes the Validation Contract after context resolution and before sandbox preparation", async () => {
    const before = activityOrder.length;
    await runWorker(async () => {
      const handle = await start("ses-val-a");
      await waitFor(() => implementsOf("run-ses-val-a").length === 1, "the Implementer of val-a");
      await handle.signal(stopSignal);
      await handle.result();
    });

    const order = activityOrder.slice(before);
    // SDD section 49 fixes this order. The contract must freeze before any sandbox exists.
    expect(order).toEqual(["resolveContext", "buildValidationContract", "prepareSandbox"]);
  });

  it("reports BUILDING_VALIDATION_CONTRACT to setRunStatus", async () => {
    await runWorker(async () => {
      const handle = await start("ses-val-b");
      await waitFor(() => implementsOf("run-ses-val-b").length === 1, "the Implementer of val-b");
      await handle.signal(stopSignal);
      await handle.result();
    });

    const statuses = statusesOf("run-ses-val-b");
    const context = statuses.indexOf("RESOLVING_CONTEXT");
    const building = statuses.indexOf("BUILDING_VALIDATION_CONTRACT");
    const preparing = statuses.indexOf("PREPARING");
    expect(context).toBeGreaterThanOrEqual(0);
    expect(building).toBeGreaterThan(context);
    expect(preparing).toBeGreaterThan(building);
  });

  it("reports the frozen hash in the run status query", async () => {
    await runWorker(async () => {
      const handle = await start("ses-val-c");
      await waitFor(() => implementsOf("run-ses-val-c").length === 1, "the Implementer of val-c");
      await handle.signal(stopSignal);
      await handle.result();

      // SDD section 53. The Run reports the version of the frozen contract.
      const snapshot = await handle.query(runStatusQuery);
      expect(snapshot.validationContractVersion).toBe(VALIDATION_SHA);
    });
  });

  it("gives the frozen contract document to the Implementer", async () => {
    await runWorker(async () => {
      const handle = await start("ses-val-d");
      await waitFor(() => implementsOf("run-ses-val-d").length === 1, "the Implementer of val-d");
      // SDD section 34. The prompt carries the frozen document, not a placeholder.
      expect(implementsOf("run-ses-val-d")[0]?.validationContract).toBe(VALIDATION_DOCUMENT);
      await handle.signal(stopSignal);
      await handle.result();
    });
  });

  it("asks the human one question when the contract needs input, and freezes after the answer", async () => {
    validationOutcomes.set("run-ses-val-e", (call) => (call === 1 ? NEEDS_INPUT : READY));
    const before = elicitations.length;
    await runWorker(async () => {
      const handle = await start("ses-val-e");
      await waitFor(() => elicitations.length === before + 1, "the question of val-e");
      expect(elicitations[before]).toMatch(/observable behavior/);
      // SDD section 9 item 5. No assertion exists yet, so no sandbox exists yet.
      expect(preparedOf("run-ses-val-e")).toEqual([]);

      await handle.signal(humanInputSignal, "The /health endpoint answers 200.");
      await waitFor(() => preparedOf("run-ses-val-e").length === 1, "the sandbox of val-e");

      // The answer travelled into the second build call as a human assertion.
      const second = validationsOf("run-ses-val-e")[1];
      expect(second?.humanAssertions).toEqual(["The /health endpoint answers 200."]);

      await waitFor(() => implementsOf("run-ses-val-e").length === 1, "the Implementer of val-e");
      await handle.signal(stopSignal);
      await handle.result();
    });
    validationOutcomes.delete("run-ses-val-e");
    expect(elicitations.length - before).toBe(1);
  });

  it("fails with VALIDATION_UNRESOLVED when the question stays unanswered", async () => {
    // No answer states an assertion, so every build reports the gate again. The bounded
    // question rounds must end the Run.
    validationOutcomes.set("run-ses-val-f", () => NEEDS_INPUT);
    const before = elicitations.length;

    const result = await runWorker(async () => {
      const handle = await start("ses-val-f");
      for (let round = 0; round < MAX_QUESTION_ROUNDS; round += 1) {
        await waitFor(() => elicitations.length === before + round + 1, `question ${round + 1}`);
        await handle.signal(humanInputSignal, `answer ${round}`);
      }
      return handle.result();
    });
    validationOutcomes.delete("run-ses-val-f");

    expect(elicitations.length - before).toBe(MAX_QUESTION_ROUNDS);
    expect(result.status).toBe("FAILED");
    expect(completionsOf("run-ses-val-f").at(-1)?.failureReason).toBe("VALIDATION_UNRESOLVED");
    // SDD section 9 item 5. Implementation must not start, so no sandbox exists.
    expect(preparedOf("run-ses-val-f")).toEqual([]);
    expect(implementsOf("run-ses-val-f")).toEqual([]);
  });

  it("prepares no sandbox when a stop arrives while the contract is built", async () => {
    const release = hold(heldValidations, "run-ses-val-g");
    const result = await runWorker(async () => {
      const handle = await start("ses-val-g");
      await waitForStatus(handle, "BUILDING_VALIDATION_CONTRACT");
      await handle.signal(stopSignal);
      release();
      return handle.result();
    });
    heldValidations.delete("run-ses-val-g");

    // SDD section 50. The stop prevents preparation and prevents publication.
    expect(result.status).toBe("CANCELLED");
    expect(preparedOf("run-ses-val-g")).toEqual([]);
    expect(implementsOf("run-ses-val-g")).toEqual([]);
  });
});
