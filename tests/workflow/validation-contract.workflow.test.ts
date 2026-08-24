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
  heldVerifications,
  implementCalls,
  verifyCalls,
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
const verifyCallsOf = (runId: string) => verifyCalls.filter((entry) => entry.runId === runId);
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
  it("AT-10 — the Validation Contract is frozen and its hash reaches the Run before the Implementer starts", async () => {
    // AT-10, SDD section 66. This is the ordering half: it drives the real workflow and proves,
    // from activity order the test does not sequence itself, that buildValidationContract has
    // already run and the frozen document has already reached the Implementer input by the
    // moment the implement activity is invoked. tests/acceptance/at-10-validation-created-first.test.ts
    // holds the persistence half: the frozen contract carries a creation time and a SHA-256
    // hash, and the Run row carries that hash.
    const before = activityOrder.length;
    // Deterministic verification, and then user validation, both follow the Implementer in the
    // same bounded loop. Holding verification open keeps the stop signal away from that later
    // race, because this test asserts the freeze order only and needs no later stage.
    const release = hold(heldVerifications, "run-ses-val-at10");
    await runWorker(async () => {
      const handle = await start("ses-val-at10");
      await waitFor(() => implementsOf("run-ses-val-at10").length === 1, "the Implementer of at10");

      // Nothing here writes to activityOrder itself; the workflow does. If a regression let the
      // implement activity start before buildValidationContract ran, this slice, read at the
      // instant implementCalls first holds an entry, would not yet contain
      // "buildValidationContract", and the assertion below would fail.
      const order = activityOrder.slice(before);
      expect(order).toContain("buildValidationContract");
      expect(order).toContain("prepareSandbox");
      expect(order.indexOf("buildValidationContract")).toBeLessThan(order.indexOf("prepareSandbox"));

      // SDD section 34. The Implementer never received a placeholder: the input already carries
      // the document buildValidationContract froze.
      expect(implementsOf("run-ses-val-at10")[0]?.validationContract).toBe(VALIDATION_DOCUMENT);

      // SDD section 53. The Run reports the frozen hash, already set before the Implementer runs.
      const snapshot = await handle.query(runStatusQuery);
      expect(snapshot.validationContractVersion).toBe(VALIDATION_SHA);

      await waitFor(
        () => verifyCallsOf("run-ses-val-at10").length === 1,
        "the held verification of at10",
      );
      await handle.signal(stopSignal);
      release();
      await handle.result();
    });
    heldVerifications.delete("run-ses-val-at10");
  });

  it("freezes the Validation Contract after context resolution and before sandbox preparation", async () => {
    const before = activityOrder.length;
    // Deterministic verification, and then user validation, both follow the Implementer in the
    // same bounded loop. Holding verification open keeps the stop signal away from that later
    // race, because this test asserts the freeze order only and needs no later stage.
    const release = hold(heldVerifications, "run-ses-val-a");
    await runWorker(async () => {
      const handle = await start("ses-val-a");
      await waitFor(() => implementsOf("run-ses-val-a").length === 1, "the Implementer of val-a");
      await waitFor(
        () => verifyCallsOf("run-ses-val-a").length === 1,
        "the held verification of val-a",
      );
      await handle.signal(stopSignal);
      release();
      await handle.result();
    });
    heldVerifications.delete("run-ses-val-a");

    const order = activityOrder.slice(before);
    // SDD section 49 fixes this order. The contract must freeze before any sandbox exists. The
    // stop signal lands while deterministic verification is held open, so the slice also
    // carries the Implementer and that verification call, and it stops before user validation.
    expect(order).toEqual([
      "resolveContext",
      "buildValidationContract",
      "prepareSandbox",
      "implement",
      "verify",
    ]);
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

  it("fails with VALIDATION_UNRESOLVED when a ready result carries a null sha256", async () => {
    // The output type permits `status: "ready"` with a null `sha256`. The workflow must treat
    // this combination as a fault, not as a frozen contract, and must not start implementation.
    const readyWithNoHash: BuildValidationContractActivityOutput = {
      status: "ready",
      sha256: null,
      document: VALIDATION_DOCUMENT,
      assertionCount: 1,
      frozenAt: "2026-01-01T00:00:00.000Z",
      question: null,
      summary: "Factoree froze the Validation Contract with 1 assertion.",
    };
    validationOutcomes.set("run-ses-val-h", () => readyWithNoHash);

    const result = await runWorker(async () => {
      const handle = await start("ses-val-h");
      return handle.result();
    });
    validationOutcomes.delete("run-ses-val-h");

    expect(result.status).toBe("FAILED");
    expect(completionsOf("run-ses-val-h").at(-1)?.failureReason).toBe("VALIDATION_UNRESOLVED");
    expect(preparedOf("run-ses-val-h")).toEqual([]);
    expect(implementsOf("run-ses-val-h")).toEqual([]);
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
