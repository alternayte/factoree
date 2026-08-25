import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { createWorkflowHarness, waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const { statusCalls, reviewCalls, reviewReports, reviewDecisions, input, runWorker } = harness;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
});

const startRun = async (sessionId: string) =>
  environment.client.workflow.start(agentRunWorkflow, {
    taskQueue: "test",
    workflowId: buildWorkflowId("workspace-123", sessionId),
    args: [input(sessionId)],
  });

/**
 * AT-23, SDD section 64: "A style-only medium finding does not block." SDD section 41: a style
 * finding does not block at any severity, so this file proves the medium case and the blocker
 * case both. Controller decision 6 owns the second case.
 */
describe("AT-23 — a style-only finding never blocks the Run", () => {
  it.each([
    { sessionId: "ses-at23-medium", severity: "medium" as const },
    { sessionId: "ses-at23-blocker", severity: "blocker" as const },
  ])("a $severity style finding does not enter REPAIRING", async ({ sessionId, severity }) => {
    const runId = `run-${sessionId}`;
    reviewReports.set(runId, () => ({
      text: JSON.stringify({
        version: 1,
        verdict: "fail",
        findings: [
          {
            id: "RV-1",
            severity,
            category: "style",
            requirement: "VAL-API-001",
            evidence: "src/auth.ts:84",
            description: "Prefer const over let here.",
          },
        ],
      }),
      changedFiles: ["src/auth.ts"],
    }));

    await runWorker(async () => {
      const handle = await startRun(sessionId);
      await waitFor(() => reviewCalls.filter((c) => c.runId === runId).length === 1, `the review of ${runId}`);
      await handle.signal(stopSignal);
      await handle.result();
    });

    const repairs = statusCalls.filter((entry) => entry.runId === runId && entry.status === "REPAIRING");
    expect(repairs).toHaveLength(0);

    const decisions = reviewDecisions.get(runId) ?? [];
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decisions).toHaveLength(1);
    expect(decisions[0]?.decisions[0]?.blocking).toBe(false);
    expect(decisions[0]?.decisions[0]?.reason).toContain("SDD section 41");
    // A medium finding never reaches the category check: its severity alone already does not
    // block. A blocker finding does reach the category check, and the style category is what
    // stops it there. Controller decision 6 is this second case.
    if (severity === "blocker") {
      expect(decisions[0]?.decisions[0]?.reason).toContain("style");
    } else {
      expect(decisions[0]?.decisions[0]?.reason).toContain("medium");
    }
    expect(decisions[0]?.passed).toBe(true);
  });
});
