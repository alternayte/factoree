import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { humanInputSignal, stopSignal } from "~/workflows/agent-run.workflow.js";
import { MAX_QUESTION_ROUNDS } from "~/workflows/agent-run.workflow.js";
import { createWorkflowHarness, waitFor, waitForStatus } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  completions,
  implementCalls,
  elicitations,
  refineOverrides,
  runStatusQuery,
  start,
  runWorker,
} = harness;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
});

/** A Work Item that states a goal and leaves one material product decision open. */
const openQuestionWorkItem = {
  issueId: "issue-1",
  title: "Send a notification",
  description: "## Goal\n\nSend one.\n\n## Open questions\n\n- Which channel do we use?\n",
  url: null,
  labels: [],
};

const implementsOf = (runId: string) => implementCalls.filter((entry) => entry.runId === runId);
const completionsOf = (runId: string) => completions.filter((entry) => entry.runId === runId);

describe("AT-03 — a material uncertainty stops the Run before any implementation", () => {
  it("waits for one human input and starts no Implementer", async () => {
    const before = elicitations.length;
    await runWorker(async () => {
      const handle = await start("ses-at03a", { workItem: openQuestionWorkItem });
      await waitForStatus(handle, "WAITING_FOR_INPUT");

      const snapshot = await handle.query(runStatusQuery);
      expect(snapshot.status).toBe("WAITING_FOR_INPUT");
      expect(snapshot.openQuestion).toBe("Which channel do we use?");
      // SDD section 23 permits one focused question at a time.
      expect(elicitations.slice(before)).toEqual(["Which channel do we use?"]);
      // Nothing ran inside a sandbox, so nothing was implemented and nothing was published.
      expect(implementsOf("run-ses-at03a")).toEqual([]);

      await handle.signal(stopSignal);
      const result = await handle.result();
      expect(result.status).toBe("CANCELLED");
    });
  });

  it("continues to context resolution and implementation once a human answers", async () => {
    await runWorker(async () => {
      const handle = await start("ses-at03b", { workItem: openQuestionWorkItem });
      await waitForStatus(handle, "WAITING_FOR_INPUT");
      await handle.signal(humanInputSignal, "Use the existing email channel.");
      // The Implementer starts, so refinement and context resolution both completed.
      await waitFor(() => implementsOf("run-ses-at03b").length === 1, "the Implementer of at03b");

      const snapshot = await handle.query(runStatusQuery);
      // The Run holds a frozen Context Contract, and no question stays open.
      expect(snapshot.contextContractVersion).toMatch(/^[0-9a-f]{64}$/);
      expect(snapshot.openQuestion).toBeNull();
      expect(implementsOf("run-ses-at03b")).toHaveLength(1);

      await handle.signal(stopSignal);
      await handle.result();
    });
  });

  it("fails the Run with REFINEMENT_UNRESOLVED when the rounds are spent", async () => {
    // The Refinement engine numbers a question by its position in the source Work Item, so a
    // recorded answer resolves that question for good. A fixture Work Item can therefore never
    // spend the rounds. This double reports the question again on every refinement, which is
    // the outcome the workflow bound exists for.
    refineOverrides.set("run-ses-at03c", (input) => ({
      status: "needs_input",
      goal: "Send one.",
      primaryRepository: input.project.primaryRepository,
      referenceRepositories: input.project.referenceRepositories,
      acceptanceCriteria: [],
      workItemReferences: [],
      risks: [],
      unresolvedQuestions: [
        { id: "Q-1", question: "Which channel do we use?", whyMaterial: "The Work Item is open." },
      ],
      autonomyLevel: "L2",
    }));

    const before = elicitations.length;
    const result = await runWorker(async () => {
      const handle = await start("ses-at03c", { workItem: openQuestionWorkItem });
      // Five rounds are allowed. The sixth question is refused, and the Run fails.
      for (let round = 0; round < MAX_QUESTION_ROUNDS; round += 1) {
        await waitFor(() => elicitations.length === before + round + 1, `question ${round + 1}`);
        await handle.signal(humanInputSignal, `answer ${round}`);
      }
      return handle.result();
    });
    refineOverrides.delete("run-ses-at03c");

    expect(elicitations.length - before).toBe(MAX_QUESTION_ROUNDS);
    expect(result.status).toBe("FAILED");
    expect(completionsOf("run-ses-at03c").at(-1)?.failureReason).toBe("REFINEMENT_UNRESOLVED");
    expect(implementsOf("run-ses-at03c")).toEqual([]);
  });
});
