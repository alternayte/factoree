import type { FactoreeDecision } from "~/domain/runs/factoree-decision.js";
import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";
import type { CreateRunInput, RunRepository } from "~/domain/runs/run-repository.js";
import type { RunFailureReason, RunStatus } from "~/domain/runs/run-status.js";
import type { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import type { AgentSessionPort } from "~/domain/runs/ports.js";
import type { RunSlotClaim, RunSlots } from "~/domain/runs/run-slots.js";
import { metrics } from "~/telemetry/metrics.js";
import { isTerminalRunStatus } from "~/domain/runs/run-status.js";
import { failureCategoryOf } from "~/domain/runs/failure-category.js";

export interface RunActivityDependencies {
  runs: RunRepository;
  /** docs/specs/release-0-1-0.md, DI-15.13. The maxConcurrentRuns slots of each Product. */
  slots: RunSlots;
  logger: Logger;
  runners: AgentRunnerRegistry;
  agentSession: AgentSessionPort;
  /** docs/specs/run-failure-detail.md. A failure message holds error text, so it is redacted. */
  redactor: Redactor;
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
     * correct. `AGENT_HUNG` is the resume of a hung Implementer session, which
     * docs/specs/agent-session-usage-and-hangs.md charges to the repair budget.
     */
    repairReason?: "VERIFICATION" | "VALIDATION" | "REVIEW" | "AGENT_HUNG";
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
   * docs/specs/release-0-1-0.md, DI-15.13. Grants the Run a slot of its Product before PREPARING,
   * or writes QUEUED and reports how many Runs are ahead. The workflow polls it while it waits.
   */
  async claimRunSlot(input: { runId: string }): Promise<RunSlotClaim> {
    const claim = await dependencies.slots.claim(input.runId);
    dependencies.logger.info(claim.granted ? "run slot granted" : "run queued", {
      run_id: input.runId,
      step: "queue",
      ...(claim.granted ? {} : { ahead: claim.ahead }),
    });
    return claim;
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
    /** docs/specs/run-visibility.md. The sentence the human read. Absent in an older history. */
    failureMessage?: string;
    completedAt: string;
    /** DI-21.56. The total wait for a run slot or a sandbox slot. Absent in an older history. */
    waitedMs?: number;
  }): Promise<void> {
    const before = await dependencies.runs.findById(input.tenantId, input.runId);
    const alreadyTerminal = before !== null && isTerminalRunStatus(before.status);
    // SDD section 67. The category is derived from the reason, never supplied by the caller.
    const failureCategory =
      input.failureReason === undefined ? undefined : failureCategoryOf(input.failureReason);
    const run = await dependencies.runs.updateStatus(input.runId, input.status, {
      ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
      ...(failureCategory === undefined ? {} : { failureCategory }),
      ...(input.failureMessage === undefined ? {} : { failureMessage: dependencies.redactor.redactText(input.failureMessage) }),
      completedAt: new Date(input.completedAt),
      ...(input.waitedMs === undefined ? {} : { waitedMs: Math.max(0, Math.round(input.waitedMs)) }),
    });
    const labels = { tenant_id: run.tenantId, product_id: run.productId };
    const completedAt = run.completedAt ?? new Date(input.completedAt);
    // An activity retry after a successful write must not count the terminal state twice.
    if (!alreadyTerminal) {
      metrics.activeRuns.dec(labels);
      metrics.runDuration.observe(labels, Math.max(0, completedAt.getTime() - run.createdAt.getTime() - (input.waitedMs ?? 0)) / 1000);
      if (input.status === "READY_FOR_HUMAN") metrics.runsReady.inc(labels);
      else if (input.status === "REPORTED") metrics.runsReported.inc(labels);
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
   * Specification section 10. Records the repository target the workflow selected. A Version 1
   * Run has one target.
   */
  async recordRunTarget(input: {
    tenantId: string;
    runId: string;
    repositoryId: string;
    selectionReason: string;
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
   * Specification section 14. Records the per-target facts of one RunTarget as they become
   * known: the base SHA after context resolution, the patch hash and commit SHA after
   * publication, and the pull request URL once the pull request exists.
   */
  async recordRunTargetFacts(input: {
    tenantId: string;
    runId: string;
    repositoryId: string;
    baseSha?: string;
    patchSha256?: string;
    commitSha?: string;
    pullRequestUrl?: string;
  }): Promise<void> {
    const { tenantId, runId, repositoryId, ...patch } = input;
    await dependencies.runs.updateRunTarget(tenantId, runId, repositoryId, patch);
  },

  /**
   * Specification section 10. Posts the Linear notice that names the confident target and its
   * reason. The notice reaches the Run's own agent session. The activity resolves the session
   * id from the Run record.
   */
  /**
   * docs/specs/own-proposals-and-parallel-runs.md. Records a proposal Factoree took without asking.
   * The workflow posts it to Linear apart from this record, so a Linear fault never loses it.
   */
  async recordDecision(input: { tenantId: string; runId: string; decision: FactoreeDecision }): Promise<void> {
    await dependencies.runs.appendDecision(input.tenantId, input.runId, input.decision);
  },
});
