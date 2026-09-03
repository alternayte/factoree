import type { Logger } from "~/telemetry/logger.js";
import type { CreateRunInput, RunRepository } from "~/domain/runs/run-repository.js";
import type { RunFailureReason, RunStatus } from "~/domain/runs/run-status.js";
import type { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import type { AgentSessionPort } from "~/domain/runs/ports.js";
import { metrics } from "~/telemetry/metrics.js";
import { isTerminalRunStatus } from "~/domain/runs/run-status.js";
import { failureCategoryOf } from "~/domain/runs/failure-category.js";

export interface RunActivityDependencies {
  runs: RunRepository;
  logger: Logger;
  runners: AgentRunnerRegistry;
  agentSession: AgentSessionPort;
}

export const createRunActivities = (dependencies: RunActivityDependencies) => ({
  async createRun(input: CreateRunInput): Promise<{ runId: string; created: boolean }> {
    const { run, created } = await dependencies.runs.createIfAbsent(input);
    if (created) {
      metrics.runsStarted.inc({ tenant_id: input.tenantId, product_id: input.productId });
      metrics.activeRuns.inc({ tenant_id: input.tenantId, product_id: input.productId });
    }
    dependencies.logger.info("run received", {
      tenant_id: run.tenantId,
      product_id: run.productId,
      run_id: run.id,
      workflow_id: run.temporalWorkflowId,
      step: "receive",
    });
    return { runId: run.id, created };
  },

  async setRunStatus(input: {
    runId: string;
    status: RunStatus;
    startedAt?: string;
    /** SDD section 42. The number of repairs the Run has started. */
    repairCount?: number;
    /**
     * SDD section 42 and section 62. The stage that asked for this repair. Three stages can ask
     * for one, so the metric must name the right stage. The default keeps an older caller
     * correct.
     */
    repairReason?: "VERIFICATION" | "VALIDATION" | "REVIEW";
  }): Promise<void> {
    const run = await dependencies.runs.updateStatus(input.runId, input.status, {
      ...(input.startedAt === undefined ? {} : { startedAt: new Date(input.startedAt) }),
      ...(input.repairCount === undefined ? {} : { repairCount: input.repairCount }),
    });
    if (input.status === "REPAIRING") {
      // SDD section 62. The counter belongs in the activity, not in the workflow, because a
      // workflow must stay deterministic.
      metrics.repairs.inc({
        tenant_id: run.tenantId,
        product_id: run.productId,
        reason: input.repairReason ?? "VERIFICATION",
      });
    }
  },

  /**
   * SDD section 28. Refinement caps the autonomy level. The Run row is created before Refinement
   * runs, so the capped level reaches the row here.
   */
  async setRunAutonomyLevel(input: {
    tenantId: string;
    runId: string;
    autonomyLevel: string;
  }): Promise<void> {
    await dependencies.runs.setAutonomyLevel(input.tenantId, input.runId, input.autonomyLevel);
  },

  async completeRun(input: {
    tenantId: string;
    runId: string;
    status: RunStatus;
    failureReason?: RunFailureReason;
    completedAt: string;
  }): Promise<void> {
    const before = await dependencies.runs.findById(input.tenantId, input.runId);
    const alreadyTerminal = before !== null && isTerminalRunStatus(before.status);
    // SDD section 67. The category is derived from the reason, never supplied by the caller.
    const failureCategory =
      input.failureReason === undefined ? undefined : failureCategoryOf(input.failureReason);
    const run = await dependencies.runs.updateStatus(input.runId, input.status, {
      ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
      ...(failureCategory === undefined ? {} : { failureCategory }),
      completedAt: new Date(input.completedAt),
    });
    const labels = { tenant_id: run.tenantId, product_id: run.productId };
    const completedAt = run.completedAt ?? new Date(input.completedAt);
    // An activity retry after a successful write must not count the terminal state twice.
    if (!alreadyTerminal) {
      metrics.activeRuns.dec(labels);
      metrics.runDuration.observe(labels, (completedAt.getTime() - run.createdAt.getTime()) / 1000);
      if (input.status === "READY_FOR_HUMAN") metrics.runsReady.inc(labels);
      else if (input.status === "CANCELLED") metrics.runsCancelled.inc(labels);
      else
        metrics.runsFailed.inc({
          ...labels,
          reason: input.failureReason ?? "UNKNOWN",
          category: failureCategory ?? "INTERNAL",
        });
    }
    // The Run reached a terminal state. Every runner session of this Run is now dead, so the
    // runner must not keep it. This bounds `CliAgentRunner.sessions` by the Runs in flight.
    for (const runner of dependencies.runners.all()) runner.releaseRun?.(input.runId);
    dependencies.logger.info("run completed", {
      tenant_id: run.tenantId,
      product_id: run.productId,
      run_id: run.id,
      step: "complete",
      status: input.status,
    });
  },

  /**
   * Specification section 10. Records the repository target selection the workflow decided.
   * `mergeOrder` starts at one, because Task 10 selects one target only.
   */
  async recordRunTarget(input: {
    tenantId: string;
    runId: string;
    repositoryId: string;
    selectionReason: string;
    mergeOrder: number;
  }): Promise<string> {
    const target = await dependencies.runs.createRunTarget(input);
    dependencies.logger.info("run target recorded", {
      tenant_id: input.tenantId,
      run_id: input.runId,
      step: "target_selection",
    });
    return target.id;
  },

  /**
   * Specification section 10. Posts the Linear notice that names the confident target and its
   * reason. The notice reaches the Run's own agent session. The activity resolves the session
   * id from the Run record.
   */
  async postTargetNotice(input: {
    tenantId: string;
    runId: string;
    fullName: string;
    reason: string;
  }): Promise<void> {
    const run = await dependencies.runs.findById(input.tenantId, input.runId);
    if (run === null) return;
    await dependencies.agentSession.progress(
      run.linearAgentSessionId,
      `Factoree selected "${input.fullName}" as the target repository, because ${input.reason}.`,
    );
  },
});
