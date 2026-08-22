import type { Logger } from "~/telemetry/logger.js";
import type { AgentExecutionRepository } from "~/domain/runs/agent-execution.js";
import type { AgentRunnerRegistry, AgentSessionRef } from "~/domain/runs/agent-runner.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import { registerProjectSecrets } from "~/domain/projects/redaction-loader.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { buildImplementerInput } from "~/domain/runs/implementer-input.js";
import { metrics } from "~/telemetry/metrics.js";
import type { Redactor } from "~/telemetry/redaction.js";

export interface AgentActivityDependencies {
  runners: AgentRunnerRegistry;
  sandbox: Sandbox;
  executions: AgentExecutionRepository;
  secrets: SecretStore;
  redactor: Redactor;
  logger: Logger;
}

export interface ImplementActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  runnerName: string;
  spriteId: string;
  adapter: string;
  workspacePath: string;
  primaryPath: string;
  referencePaths: string[];
  goal: string;
  humanDecisions: string[];
  repositoryInstructions: string;
  repairFindings: string[];
  stagingRead: boolean;
  timeoutMs: number;
  /**
   * The ordinal of this Implementer attempt within the Run. The workflow counts it, so the
   * value stays the same across every Temporal retry of one activity and changes only for a
   * genuinely distinct attempt, for example a later repair loop attempt.
   */
  attempt: number;
}

export interface ImplementActivityOutput {
  sessionId: string;
  processId: string;
  runner: string;
  completed: boolean;
  exitCode: number;
  cancelled: boolean;
  summary: string;
  durationMs: number;
}

export const createAgentActivities = (dependencies: AgentActivityDependencies) => ({
  async implement(input: ImplementActivityInput): Promise<ImplementActivityOutput> {
    // SDD section 60: every Project secret must reach the redactor before any output is captured.
    await registerProjectSecrets(
      dependencies.redactor,
      dependencies.secrets,
      input.tenantId,
      input.projectId,
      dependencies.logger,
    );

    const names = await dependencies.secrets.listNames(input.tenantId, input.projectId);
    const projectTestSecrets: Record<string, string> = {};
    for (const name of names) {
      const value = await dependencies.secrets.get(input.tenantId, input.projectId, name);
      if (value !== null) projectTestSecrets[name] = value;
    }

    const actionPolicy = buildActionPolicy({ stagingRead: input.stagingRead });
    const implementerInput = buildImplementerInput({
      goal: input.goal,
      humanDecisions: input.humanDecisions,
      validationContract: null,
      contextContract: null,
      requiredContext: [],
      primaryRepositoryPath: input.primaryPath,
      referenceRepositoryPaths: input.referencePaths,
      repositoryInstructions: input.repositoryInstructions,
      skills: [],
      actionPolicy,
      repairFindings: input.repairFindings,
      projectTestSecrets,
    });

    const runner = dependencies.runners.get(input.runnerName);
    const result = await runner.run({
      runId: input.runId,
      tenantId: input.tenantId,
      role: "implementer",
      sandbox: dependencies.sandbox,
      ref: { id: input.spriteId, adapter: input.adapter, workspacePath: input.workspacePath },
      workingDirectory: input.primaryPath,
      prompt: implementerInput.prompt,
      promptVersion: implementerInput.promptVersion,
      environment: implementerInput.environment,
      actionPolicy,
      timeoutMs: input.timeoutMs,
    });

    await dependencies.executions.record({
      tenantId: input.tenantId,
      runId: input.runId,
      role: "implementer",
      runner: runner.name,
      model: null,
      sessionRef: result.session.sessionId,
      promptVersion: implementerInput.promptVersion,
      durationMs: result.durationMs,
      finalResult: {
        completed: result.completed,
        exitCode: result.exitCode,
        cancelled: result.cancelled,
        summary: result.summary,
      },
      // A Temporal retry presents the same Run, the same role, and the same attempt ordinal, so
      // it upserts the one row. A later attempt carries a different ordinal and writes its own
      // row.
      idempotencyKey: `run:${input.runId}:implementer:${input.attempt}`,
    });

    metrics.implementationDuration.observe(
      { tenant_id: input.tenantId, project_id: input.projectId, runner: runner.name },
      result.durationMs / 1000,
    );
    dependencies.logger.info("implementation finished", {
      tenant_id: input.tenantId,
      project_id: input.projectId,
      run_id: input.runId,
      runner: runner.name,
      completed: result.completed,
      step: "implement",
    });

    return {
      sessionId: result.session.sessionId,
      processId: result.session.processId,
      runner: runner.name,
      completed: result.completed,
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      summary: result.summary,
      durationMs: result.durationMs,
    };
  },

  async cancelImplementer(input: { runnerName: string; session: AgentSessionRef }): Promise<void> {
    // SDD section 50: a stop signal must cancel the active agent process.
    await dependencies.runners.get(input.runnerName).cancel(input.session);
  },
});
