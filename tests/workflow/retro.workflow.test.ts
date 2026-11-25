import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { retroWorkflow } from "~/workflows/retro.workflow.js";

let environment: TestWorkflowEnvironment;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
});

// docs/specs/retro-agent.md. The cost cap is the one bound on what a retro spends, so the session
// after the one that reached it must not start, and one product's fault must not end the retro.
describe("retroWorkflow (docs/specs/retro-agent.md)", () => {
  it("stops before the next product once the cap is spent, and goes on after a failed session", async () => {
    const taskQueue = `retro-${randomUUID()}`;
    const sessions: string[] = [];
    const skipped: Array<{ productId: string; status: string }> = [];
    let finished: string | null = null;
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL("../../src/workflows/retro.workflow.ts", import.meta.url).pathname,
      activities: {
        prepareRetro: () => Promise.resolve({ kind: "run", retroId: "retro-1", productIds: ["broken", "first", "second"], costCapUsd: 1 }),
        runRetroSession: (input: { productId: string }) => {
          sessions.push(input.productId);
          if (input.productId === "broken") return Promise.reject(new Error("the sandbox did not start"));
          return Promise.resolve({ costUsd: 1.5 });
        },
        skipRetroSession: (input: { productId: string; status?: string }) => {
          skipped.push({ productId: input.productId, status: input.status ?? "skipped" });
          return Promise.resolve();
        },
        finishRetro: (input: { status: string }) => {
          finished = input.status;
          return Promise.resolve();
        },
      },
    });

    await worker.runUntil(() =>
      environment.client.workflow.execute(retroWorkflow, { taskQueue, workflowId: `retro-${randomUUID()}`, args: [{ tenantId: "tenant-1", trigger: "manual" }] }),
    );

    expect(sessions).toEqual(["broken", "first"]);
    expect(skipped).toEqual([
      { productId: "broken", status: "failed" },
      { productId: "second", status: "skipped" },
    ]);
    expect(finished).toBe("succeeded");
  });
});
