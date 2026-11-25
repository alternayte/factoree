import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { repositorySetupWorkflow } from "~/workflows/repository-setup.workflow.js";

let environment: TestWorkflowEnvironment;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
});

const PROMPT = { headSha: "b".repeat(40) };

/** The calls of one setup, with the pre-check answer the test picks. */
const runSetup = async (prepared: unknown, precheck: unknown): Promise<string[]> => {
  const calls: string[] = [];
  const taskQueue = `repository-setup-${randomUUID()}`;
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowsPath: new URL("../../src/workflows/repository-setup.workflow.ts", import.meta.url).pathname,
    activities: {
      prepareSetup: () => {
        calls.push("prepareSetup");
        return Promise.resolve(prepared);
      },
      precheckNugetFeeds: (input: { prepared: { kind: string } }) => {
        calls.push(`precheckNugetFeeds:${input.prepared.kind}`);
        return Promise.resolve(precheck);
      },
      runSetupSession: (input: { prepared: { kind: string } }) => {
        calls.push(`runSetupSession:${input.prepared.kind}`);
        return Promise.resolve({ kind: "failed", reason: "stop here" });
      },
      createSetupAppChangeIssues: () => {
        calls.push("createSetupAppChangeIssues");
        return Promise.resolve();
      },
      finishSetup: (input: { status: string; failureMessage: string | null }) => {
        calls.push(`finishSetup:${input.status}:${input.failureMessage ?? ""}`);
        return Promise.resolve();
      },
    },
  });
  await worker.runUntil(environment.client.workflow.execute(repositorySetupWorkflow, { taskQueue, workflowId: `setup-${randomUUID()}`, args: [{ setupId: "setup-1" }] }));
  return calls;
};

describe("repositorySetupWorkflow, the NuGet pre-check (docs/specs/nuget-private-feed-mapping.md)", () => {
  it("runs no pre-check when the inputs need none", async () => {
    const calls = await runSetup({ kind: "run", defaultBranch: "main", ...PROMPT, prompt: {} }, null);
    expect(calls).toEqual(["prepareSetup", "runSetupSession:run", "finishSetup:failed:stop here"]);
  });

  it("fails the setup on a failed pre-check, with no session and no app-change issue", async () => {
    const calls = await runSetup({ kind: "precheck", defaultBranch: "main", ...PROMPT, prompt: {} }, { kind: "failed", reason: "The NuGet pre-check failed: x" });
    expect(calls).toEqual(["prepareSetup", "precheckNugetFeeds:precheck", "finishSetup:failed:The NuGet pre-check failed: x"]);
  });

  it("gives the session what a passed pre-check returns, and ends a skipped one", async () => {
    const ran = await runSetup({ kind: "precheck", defaultBranch: "main", ...PROMPT, prompt: {} }, { kind: "run", defaultBranch: "main", ...PROMPT, prompt: {} });
    expect(ran).toEqual(["prepareSetup", "precheckNugetFeeds:precheck", "runSetupSession:run", "finishSetup:failed:stop here"]);
    const skipped = await runSetup({ kind: "precheck", defaultBranch: "main", ...PROMPT, prompt: {} }, { kind: "skipped" });
    expect(skipped).toEqual(["prepareSetup", "precheckNugetFeeds:precheck"]);
  });
});
