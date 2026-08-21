import type { Logger } from "~/telemetry/logger.js";
import type { CreateRunInput, RunRepository } from "~/domain/runs/run-repository.js";
import type { RunFailureReason, RunStatus } from "~/domain/runs/run-status.js";
import { metrics } from "~/telemetry/metrics.js";

export interface RunActivityDependencies {
  runs: RunRepository;
  logger: Logger;
}

export const createRunActivities = (dependencies: RunActivityDependencies) => ({
  async createRun(input: CreateRunInput): Promise<{ runId: string; created: boolean }> {
    const { run, created } = await dependencies.runs.createIfAbsent(input);
    if (created) {
      metrics.runsStarted.inc({ tenant_id: input.tenantId, project_id: input.projectId });
      metrics.activeRuns.inc({ tenant_id: input.tenantId, project_id: input.projectId });
    }
    dependencies.logger.info("run received", {
      tenant_id: run.tenantId,
      project_id: run.projectId,
      run_id: run.id,
      workflow_id: run.temporalWorkflowId,
      step: "receive",
    });
    return { runId: run.id, created };
  },

  async setRunStatus(input: { runId: string; status: RunStatus; startedAt?: string }): Promise<void> {
    await dependencies.runs.updateStatus(input.runId, input.status, {
      ...(input.startedAt === undefined ? {} : { startedAt: new Date(input.startedAt) }),
    });
  },

  async completeRun(input: {
    runId: string;
    status: RunStatus;
    failureReason?: RunFailureReason;
    completedAt: string;
  }): Promise<void> {
    const run = await dependencies.runs.updateStatus(input.runId, input.status, {
      ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
      completedAt: new Date(input.completedAt),
    });
    const labels = { tenant_id: run.tenantId, project_id: run.projectId };
    const completedAt = run.completedAt ?? new Date(input.completedAt);
    metrics.activeRuns.dec(labels);
    metrics.runDuration.observe(labels, (completedAt.getTime() - run.createdAt.getTime()) / 1000);
    if (input.status === "READY_FOR_HUMAN") metrics.runsReady.inc(labels);
    else if (input.status === "CANCELLED") metrics.runsCancelled.inc(labels);
    else metrics.runsFailed.inc({ ...labels, reason: input.failureReason ?? "UNKNOWN" });
    dependencies.logger.info("run completed", {
      tenant_id: run.tenantId,
      project_id: run.projectId,
      run_id: run.id,
      step: "complete",
      status: input.status,
    });
  },
});
