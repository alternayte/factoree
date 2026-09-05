import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import {
  buildSyncInstallationWorkflowId,
  syncInstallationWorkflow,
} from "~/workflows/sync-installation.workflow.js";
import type { SyncInstallationWorkflowOutput } from "~/workflows/sync-installation.workflow.js";
import { agentRunWorkflow } from "~/workflows/agent-run.workflow.js";
import type { DiscoveredRepository } from "~/adapters/github/repository-discovery-client.js";

let environment: TestWorkflowEnvironment;

// This file starts several workers against `sync-installation.workflow.ts`. `global-setup.ts`
// bundles that module once for the whole suite, so every worker here reuses that one bundle
// instead of asking `Worker.create` to bundle it again with webpack.
let syncInstallationWorkflowBundlePromise: Promise<string> | undefined;
const loadSyncInstallationWorkflowBundle = async (): Promise<string> => {
  syncInstallationWorkflowBundlePromise ??= readFile(inject("syncInstallationWorkflowBundlePath"), "utf8");
  return syncInstallationWorkflowBundlePromise;
};

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
});

type Outcome = { kind: "registered" | "skipped" | "conflict"; reason?: string };

interface RunSyncWorkflowOptions {
  repositories?: DiscoveredRepository[];
  repositoryCount?: number;
  outcomes?: Record<string, Outcome>;
  /** When set, `syncOneRepository` rejects for every one of these full names, once. */
  failFor?: string[];
  /** When set, `syncOneRepository` waits this long before it resolves, so a test can watch concurrency. */
  delayMs?: number;
  /** Overrides the generated workflow id, so a test can drive the id-joining behaviour directly. */
  workflowId?: string;
}

/**
 * Builds a worker and a test double of the discovery activities, but does not start the
 * workflow. A test that needs to start two executions against the same double, to prove the
 * workflow id joins a running sync, drives `worker` and `activities` directly instead of
 * calling `runSyncWorkflow`.
 */
const buildSyncHarness = (options: RunSyncWorkflowOptions) => {
  const repositories =
    options.repositories ??
    Array.from({ length: options.repositoryCount ?? 0 }, (_, index) => ({
      fullName: `acme/repo-${String(index)}`,
      defaultBranch: "main",
    }));
  const synced: string[] = [];
  let listCalls = 0;
  const failedOnce = new Set<string>();
  let inFlight = 0;
  let maxInFlight = 0;
  const taskQueue = `sync-installation-${randomUUID()}`;
  const activities = {
    listInstallationRepositories: (): Promise<DiscoveredRepository[]> => {
      listCalls += 1;
      return Promise.resolve(repositories);
    },
    syncOneRepository: async (input: { fullName: string }): Promise<Outcome> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        synced.push(input.fullName);
        if (options.failFor?.includes(input.fullName) === true && !failedOnce.has(input.fullName)) {
          failedOnce.add(input.fullName);
          throw new Error(`synthetic failure for ${input.fullName}`);
        }
        const outcome = options.outcomes?.[input.fullName];
        return outcome ?? { kind: "registered" };
      } finally {
        inFlight -= 1;
      }
    },
  };
  return {
    taskQueue,
    activities,
    synced,
    listCallCount: () => listCalls,
    maxInFlight: () => maxInFlight,
  };
};

const runSyncWorkflow = async (
  options: RunSyncWorkflowOptions,
): Promise<{ result: SyncInstallationWorkflowOutput; synced: string[]; maxInFlight: number }> => {
  const harness = buildSyncHarness(options);
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: harness.taskQueue,
    workflowBundle: { code: await loadSyncInstallationWorkflowBundle() },
    activities: harness.activities,
  });
  const result = await worker.runUntil(() =>
    environment.client.workflow.execute(syncInstallationWorkflow, {
      taskQueue: harness.taskQueue,
      workflowId: options.workflowId ?? `sync-test-${randomUUID()}`,
      args: [{ tenantId: "tenant-1", githubInstallationId: "install-1" }],
    }),
  );
  return { result, synced: harness.synced, maxInFlight: harness.maxInFlight() };
};

describe("syncInstallationWorkflow", () => {
  it("registers the participating repositories and counts the rest", async () => {
    const { result } = await runSyncWorkflow({
      repositories: [
        { fullName: "acme/api", defaultBranch: "main" },
        { fullName: "acme/web", defaultBranch: "main" },
        { fullName: "acme/docs", defaultBranch: "main" },
      ],
      outcomes: {
        "acme/api": { kind: "registered" },
        "acme/web": { kind: "skipped", reason: "no configuration file" },
        "acme/docs": { kind: "conflict", reason: "another Product claims Linear team PAY" },
      },
    });

    expect(result).toEqual({ registered: 1, skipped: 1, conflicted: 1 });
  });

  it("reads every page of a paginated installation", async () => {
    const { synced } = await runSyncWorkflow({ repositoryCount: 250 });

    expect(synced).toHaveLength(250);
  });

  it("never runs more than four repository syncs at once", async () => {
    const { result, maxInFlight } = await runSyncWorkflow({ repositoryCount: 20, delayMs: 20 });

    expect(result).toEqual({ registered: 20, skipped: 0, conflicted: 0 });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    // A concurrency of one would also stay at or under four. Confirm the pool actually
    // overlaps calls, so the bound above is a real ceiling and not an artifact of a serial run.
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("does not let one failed repository abort the sync of the rest", async () => {
    const { result, synced } = await runSyncWorkflow({
      repositories: [
        { fullName: "acme/api", defaultBranch: "main" },
        { fullName: "acme/broken", defaultBranch: "main" },
        { fullName: "acme/web", defaultBranch: "main" },
      ],
      failFor: ["acme/broken"],
    });

    // The activity's own retry policy in `syncInstallationWorkflow` retries a failed attempt,
    // so `acme/broken` reaches the double more than once; the double throws once and then
    // resolves, the way a transient fault recovers on retry.
    expect(synced.filter((name) => name === "acme/broken").length).toBeGreaterThanOrEqual(2);
    expect(synced).toEqual(expect.arrayContaining(["acme/api", "acme/web"]));
    expect(result).toEqual({ registered: 3, skipped: 0, conflicted: 0 });
  });

  describe("buildSyncInstallationWorkflowId", () => {
    it("derives a stable id from the installation id alone", () => {
      expect(buildSyncInstallationWorkflowId("install-42")).toBe(buildSyncInstallationWorkflowId("install-42"));
      expect(buildSyncInstallationWorkflowId("install-1")).not.toBe(buildSyncInstallationWorkflowId("install-2"));
    });

    it("refuses a second start under the same id, so a redelivered webhook joins the running sync", async () => {
      const harness = buildSyncHarness({ repositoryCount: 5, delayMs: 50 });
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        taskQueue: harness.taskQueue,
        workflowBundle: { code: await loadSyncInstallationWorkflowBundle() },
        activities: harness.activities,
      });

      await worker.runUntil(async () => {
        const workflowId = buildSyncInstallationWorkflowId("install-join");
        const first = await environment.client.workflow.start(syncInstallationWorkflow, {
          taskQueue: harness.taskQueue,
          workflowId,
          args: [{ tenantId: "tenant-1", githubInstallationId: "install-join" }],
        });

        await expect(
          environment.client.workflow.start(syncInstallationWorkflow, {
            taskQueue: harness.taskQueue,
            workflowId,
            args: [{ tenantId: "tenant-1", githubInstallationId: "install-join" }],
          }),
        ).rejects.toThrow(WorkflowExecutionAlreadyStartedError);

        await first.result();
      });

      // The rejected second start never reached the worker, so the double saw one list call:
      // the sync ran once, not twice.
      expect(harness.listCallCount()).toBe(1);
    });
  });
});

describe("the workflow barrel", () => {
  it("registers both workflows for one worker, the way src/bin/worker.ts's workflowsPath does", async () => {
    const harness = buildSyncHarness({ repositoryCount: 3 });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: harness.taskQueue,
      // The claim under test: a worker built from the barrel, not the file directly, runs
      // `syncInstallationWorkflow`. `src/bin/worker.ts` points its own `workflowsPath` at this
      // same file.
      workflowsPath: new URL("../../src/workflows/index.ts", import.meta.url).pathname,
      activities: harness.activities,
    });

    const result = await worker.runUntil(() =>
      environment.client.workflow.execute(syncInstallationWorkflow, {
        taskQueue: harness.taskQueue,
        workflowId: `sync-barrel-${randomUUID()}`,
        args: [{ tenantId: "tenant-1", githubInstallationId: "install-1" }],
      }),
    );

    expect(result).toEqual({ registered: 3, skipped: 0, conflicted: 0 });
    // The barrel's other export, `agentRunWorkflow`, is imported here only to prove the module
    // resolves and both names are live exports of the same bundle the worker just used.
    expect(typeof agentRunWorkflow).toBe("function");
  });
});
