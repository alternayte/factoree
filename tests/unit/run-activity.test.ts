import { describe, expect, it } from "vitest";
import { createRunActivities } from "~/activities/run.activities.js";
import type { RunRecord, RunRepository, RunStatusPatch } from "~/domain/runs/run-repository.js";
import type { RunStatus } from "~/domain/runs/run-status.js";
import type { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import { metrics } from "~/telemetry/metrics.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";

const record = (status: RunStatus, repairCount: number): RunRecord => ({
  id: "run-1",
  tenantId: "tenant-1",
  productId: "product-1",
  linearIssueId: null,
  linearAgentSessionId: "session-1",
  temporalWorkflowId: "workflow-1",
  status,
  failureReason: null,
  failureCategory: null,
  autonomyLevel: "L2",
  implementerRunner: null,
  validatorRunner: null,
  reviewerRunner: null,
  spriteId: null,
  spriteAdapter: null,
  spriteRetainUntil: null,
  baseSha: null,
  patchSha256: null,
  commitSha: null,
  pullRequestUrl: null,
  contextContractVersion: null,
  validationContractVersion: null,
  organizationSkillsSha: null,
  proofPackSha256: null,
  proofPackPostedAt: null,
  repairCount,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  startedAt: null,
  completedAt: null,
});

/** Records every `updateStatus` call, so a test can read the patch the activity sent. */
const build = () => {
  const calls: Array<{ id: string; status: RunStatus; patch?: RunStatusPatch }> = [];
  const released: string[] = [];
  const runs = {
    updateStatus: (id: string, status: RunStatus, patch?: RunStatusPatch) => {
      calls.push({ id, status, ...(patch === undefined ? {} : { patch }) });
      return Promise.resolve(record(status, patch?.repairCount ?? 0));
    },
    findById: () => Promise.resolve(null),
  } as unknown as RunRepository;
  const redactor = new Redactor();
  // A minimal double of `AgentRunnerRegistry`. Its one runner records every run id `completeRun`
  // releases, so a test can prove the release reaches the runner.
  const runners = {
    all: () => [{ name: "fake", releaseRun: (runId: string) => released.push(runId) }],
  } as unknown as AgentRunnerRegistry;
  const activities = createRunActivities({ runs, logger: createLogger({ level: "error", redactor }), runners });
  return { activities, calls, released };
};

/** The current value of `factoree_repairs_total` for the labels of the test Run and one reason. */
const repairCount = async (reason = "VERIFICATION"): Promise<number> => {
  const metric = await metrics.repairs.get();
  const sample = metric.values.find(
    (value) =>
      value.labels.tenant_id === "tenant-1" &&
      value.labels.project_id === "product-1" &&
      value.labels.reason === reason,
  );
  return sample?.value ?? 0;
};

describe("setRunStatus", () => {
  it("passes the repair count of SDD section 53 into the status patch", async () => {
    const { activities, calls } = build();
    await activities.setRunStatus({ runId: "run-1", status: "REPAIRING", repairCount: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("REPAIRING");
    expect(calls[0]?.patch?.repairCount).toBe(2);
  });

  it("omits the repair count from the patch when the caller sent none", async () => {
    const { activities, calls } = build();
    await activities.setRunStatus({ runId: "run-1", status: "IMPLEMENTING" });
    expect(calls[0]?.patch).not.toHaveProperty("repairCount");
  });

  it("counts one repair of SDD section 62 when the Run enters REPAIRING", async () => {
    const { activities } = build();
    const before = await repairCount();
    await activities.setRunStatus({ runId: "run-1", status: "REPAIRING", repairCount: 1 });
    expect(await repairCount()).toBe(before + 1);
  });

  it("counts the repair against the stage the caller named", async () => {
    // SDD section 42 and section 62. Three stages can ask for a repair, so the metric must name
    // the stage that asked for this one.
    const { activities } = build();
    const before = await repairCount("REVIEW");
    await activities.setRunStatus({
      runId: "run-1",
      status: "REPAIRING",
      repairCount: 1,
      repairReason: "REVIEW",
    });
    expect(await repairCount("REVIEW")).toBe(before + 1);
  });

  it("counts the repair against verification when the caller named no stage", async () => {
    const { activities } = build();
    const before = await repairCount();
    await activities.setRunStatus({ runId: "run-1", status: "REPAIRING", repairCount: 1 });
    expect(await repairCount()).toBe(before + 1);
  });

  it("counts no repair for any other status", async () => {
    const { activities } = build();
    const before = await repairCount();
    await activities.setRunStatus({ runId: "run-1", status: "IMPLEMENTING" });
    await activities.setRunStatus({ runId: "run-1", status: "VERIFYING" });
    await activities.setRunStatus({ runId: "run-1", status: "PREPARING" });
    expect(await repairCount()).toBe(before);
  });
});

describe("completeRun", () => {
  it("derives the category from the reason and never reads it from the caller (SDD section 67)", async () => {
    const { activities, calls } = build();
    await activities.completeRun({
      tenantId: "tenant-1",
      runId: "run-1",
      status: "FAILED",
      failureReason: "PATCH_HASH_MISMATCH",
      completedAt: new Date().toISOString(),
    });
    // The activity input carries no category. The persisted patch must still carry one.
    expect(calls.find((call) => call.status === "FAILED")?.patch?.failureCategory).toBe(
      "PUBLICATION",
    );
  });

  it("releases every runner session when the Run reaches a terminal state", async () => {
    const { activities, released } = build();
    await activities.completeRun({
      tenantId: "tenant-1",
      runId: "run-1",
      status: "READY_FOR_HUMAN",
      completedAt: new Date().toISOString(),
    });
    expect(released).toEqual(["run-1"]);
  });
});
