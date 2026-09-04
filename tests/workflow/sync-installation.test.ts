import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { syncInstallationWorkflow } from "~/workflows/sync-installation.workflow.js";
import type { SyncInstallationWorkflowOutput } from "~/workflows/sync-installation.workflow.js";
import type { DiscoveredRepository } from "~/adapters/github/repository-discovery-client.js";

let environment: TestWorkflowEnvironment;

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
}

/**
 * Drives `syncInstallationWorkflow` against a test double of the discovery activities. The
 * double records every repository `syncOneRepository` receives, so a test can confirm the
 * workflow reads every page of a paginated installation.
 */
const runSyncWorkflow = async (
  options: RunSyncWorkflowOptions,
): Promise<{ result: SyncInstallationWorkflowOutput; synced: string[] }> => {
  const repositories =
    options.repositories ??
    Array.from({ length: options.repositoryCount ?? 0 }, (_, index) => ({
      fullName: `acme/repo-${String(index)}`,
      defaultBranch: "main",
    }));
  const synced: string[] = [];
  const taskQueue = `sync-installation-${randomUUID()}`;
  const activities = {
    listInstallationRepositories: (): Promise<DiscoveredRepository[]> => Promise.resolve(repositories),
    syncOneRepository: (input: { fullName: string }): Promise<Outcome> => {
      synced.push(input.fullName);
      const outcome = options.outcomes?.[input.fullName];
      return Promise.resolve(outcome ?? { kind: "registered" });
    },
  };
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowsPath: new URL("../../src/workflows/sync-installation.workflow.ts", import.meta.url).pathname,
    activities,
  });
  const result = await worker.runUntil(() =>
    environment.client.workflow.execute(syncInstallationWorkflow, {
      taskQueue,
      workflowId: `sync-test-${randomUUID()}`,
      args: [{ tenantId: "tenant-1", githubInstallationId: "install-1" }],
    }),
  );
  return { result, synced };
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
});
