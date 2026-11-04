import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { buildAheadSignal, buildAheadWorkflow } from "~/workflows/build-ahead.workflow.js";
import { buildAheadWorkflowId, type BuildAheadRequest } from "~/domain/runs/build-ahead.js";
import { waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
});

describe("buildAheadWorkflow (docs/specs/run-speed.md)", () => {
  it("queues one more build for any number of requests during a build", async () => {
    const request: BuildAheadRequest = { tenantId: "tenant-1", productId: "product-1", repositoryFullName: "acme/shop" };
    const taskQueue = `build-ahead-${randomUUID()}`;
    let builds = 0;
    let release = (): void => undefined;
    const firstBuild = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL("../../src/workflows/build-ahead.workflow.ts", import.meta.url).pathname,
      activities: {
        buildWarmSnapshotAhead: async () => {
          builds += 1;
          if (builds === 1) await firstBuild;
          return { kind: "skipped", reason: "test" };
        },
      },
    });

    const requestBuild = () =>
      environment.client.workflow.signalWithStart(buildAheadWorkflow, {
        taskQueue,
        workflowId: buildAheadWorkflowId(request.tenantId, request.repositoryFullName),
        args: [request],
        signal: buildAheadSignal,
        signalArgs: [],
      });

    await worker.runUntil(async () => {
      const handle = await requestBuild();
      await waitFor(() => builds === 1, "the first build");
      // Two pushes arrive while the first build runs.
      await requestBuild();
      await requestBuild();
      release();
      await handle.result();
    });

    expect(builds).toBe(2);
  });
});
