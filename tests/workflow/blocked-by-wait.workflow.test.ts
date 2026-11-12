import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { createWorkflowHarness } from "./support/harness.js";

// docs/specs/blocked-by-wait.md. A stop cancels a waiting run as a row. A sweep that started the
// workflow before it saw the stop must not run the cancelled run.

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const { acknowledged, cancelledBeforeStart, completions, statusesOf, input, runWorker } = harness;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
});

describe("the start of a released run", () => {
  it("ends at once with no write when its waiting row was cancelled first", async () => {
    cancelledBeforeStart.add("waiting-stopped");
    const result = await runWorker(async () =>
      environment.client.workflow.execute(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "waiting-stopped"),
        args: [input("waiting-stopped")],
      }),
    );
    expect(result).toEqual({ runId: "run-waiting-stopped", status: "CANCELLED" });
    expect(acknowledged).not.toContain("waiting-stopped");
    expect(statusesOf("run-waiting-stopped")).toEqual([]);
    expect(completions.filter((entry) => entry.runId === "run-waiting-stopped")).toEqual([]);
  });
});
