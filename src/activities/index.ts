import type { Logger } from "~/telemetry/logger.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { AgentSessionPort } from "~/domain/runs/ports.js";
import type { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import type { SpriteReaper } from "~/domain/runs/sprite-reaper.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import type { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import type { AgentExecutionRepository } from "~/domain/runs/agent-execution.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";
import type { EvidenceStore } from "~/domain/evidence/evidence.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { createRunActivities } from "./run.activities.js";
import { createLinearActivities } from "./linear.activities.js";
import { createSandboxActivities } from "./sandbox.activities.js";
import { createAgentActivities } from "./agent.activities.js";
import { createVerificationActivities } from "./verification.activities.js";

export interface ActivityDependencies {
  runs: RunRepository;
  agentSession: AgentSessionPort;
  sandboxManager: SandboxManager;
  sandbox: Sandbox;
  runners: AgentRunnerRegistry;
  executions: AgentExecutionRepository;
  secrets: SecretStore;
  evidence: EvidenceStore;
  redactor: Redactor;
  reaper: SpriteReaper;
  logger: Logger;
}

export const createActivities = (dependencies: ActivityDependencies) => ({
  ...createRunActivities({ runs: dependencies.runs, logger: dependencies.logger }),
  ...createLinearActivities({ agentSession: dependencies.agentSession }),
  ...createSandboxActivities({
    sandboxManager: dependencies.sandboxManager,
    sandbox: dependencies.sandbox,
    runs: dependencies.runs,
    reaper: dependencies.reaper,
    secrets: dependencies.secrets,
    redactor: dependencies.redactor,
    logger: dependencies.logger,
  }),
  ...createAgentActivities({
    runners: dependencies.runners,
    sandbox: dependencies.sandbox,
    executions: dependencies.executions,
    secrets: dependencies.secrets,
    redactor: dependencies.redactor,
    logger: dependencies.logger,
  }),
  ...createVerificationActivities({
    sandbox: dependencies.sandbox,
    evidence: dependencies.evidence,
    secrets: dependencies.secrets,
    redactor: dependencies.redactor,
    logger: dependencies.logger,
  }),
});

export type Activities = ReturnType<typeof createActivities>;
