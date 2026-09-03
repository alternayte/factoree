import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { humanInputSignal, stopSignal } from "~/workflows/agent-run.workflow.js";
import { createWorkflowHarness, waitFor, waitForStatus } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  implementCalls,
  recordRunTargetCalls,
  postTargetNoticeCalls,
  productInput,
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

const implementsOf = (runId: string) => implementCalls.filter((entry) => entry.runId === runId);
const targetsOf = (runId: string) => recordRunTargetCalls.filter((entry) => entry.runId === runId);
const noticesOf = (runId: string) => postTargetNoticeCalls.filter((entry) => entry.runId === runId);

/** Specification section 10. Two present repositories of one Product, for the ambiguous cases. */
const twoRepositories = [
  { id: "repository-api", fullName: "acme/api", defaultBranch: "main", absentSince: null },
  { id: "repository-web", fullName: "acme/web", defaultBranch: "main", absentSince: null },
];

describe("target selection and the RunTarget row", () => {
  it("selects the sole member and posts no notice", async () => {
    await runWorker(async () => {
      const handle = await start("ses-target-sole");
      await waitFor(
        () => implementsOf("run-ses-target-sole").length === 1,
        "the Implementer of target-sole",
      );

      expect(targetsOf("run-ses-target-sole")).toEqual([
        expect.objectContaining({
          repositoryId: "repository-1",
          selectionReason: "sole member",
          mergeOrder: 1,
        }),
      ]);
      expect(noticesOf("run-ses-target-sole")).toEqual([]);

      await handle.signal(stopSignal);
      const result = await handle.result();
      expect(result.status).not.toBe("BLOCKED_TARGET");
    });
  });

  it("posts a notice for a confident target among several members", async () => {
    await runWorker(async () => {
      const handle = await start("ses-target-confident", {
        product: { ...productInput, repositories: twoRepositories },
        repositoryProposal: {
          fullName: "acme/web",
          reason: "the change is in the checkout form",
          confident: true,
        },
      });
      await waitFor(
        () => implementsOf("run-ses-target-confident").length === 1,
        "the Implementer of target-confident",
      );

      expect(targetsOf("run-ses-target-confident")).toEqual([
        expect.objectContaining({
          repositoryId: "repository-web",
          selectionReason: "the change is in the checkout form",
          mergeOrder: 1,
        }),
      ]);
      expect(noticesOf("run-ses-target-confident")).toEqual([
        expect.objectContaining({
          fullName: "acme/web",
          reason: "the change is in the checkout form",
        }),
      ]);

      await handle.signal(stopSignal);
      await handle.result();
    });
  });

  it("blocks on an ambiguous target and resumes on a human reply", async () => {
    await runWorker(async () => {
      const handle = await start("ses-target-ambiguous", {
        product: { ...productInput, repositories: twoRepositories },
        repositoryProposal: null,
      });
      await waitForStatus(handle, "BLOCKED_TARGET");

      const blocked = await handle.query(runStatusQuery);
      expect(blocked.status).toBe("BLOCKED_TARGET");
      expect(implementsOf("run-ses-target-ambiguous")).toEqual([]);

      await handle.signal(humanInputSignal, "use acme/web");

      const result = await handle.result();
      expect(result.status).not.toBe("BLOCKED_TARGET");
      expect(targetsOf("run-ses-target-ambiguous")).toEqual([
        expect.objectContaining({ repositoryId: "repository-web", mergeOrder: 1 }),
      ]);
    });
  });
});
