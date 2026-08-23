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
import type { RefinementEngine } from "~/domain/refinement/refinement-engine.js";
import type { ContextResolver } from "~/domain/context/context-resolver.js";
import type { ContextContractStore } from "~/domain/context/context-contract-store.js";
import type { ContextSourceProvider } from "~/domain/context/context-source-provider.js";
import type { RepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { createRunActivities } from "./run.activities.js";
import { createLinearActivities } from "./linear.activities.js";
import { createSandboxActivities } from "./sandbox.activities.js";
import { createAgentActivities } from "./agent.activities.js";
import { createVerificationActivities } from "./verification.activities.js";
import { createRefinementActivities } from "./refinement.activities.js";
import { createContextActivities } from "./context.activities.js";

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
  refinement: RefinementEngine;
  contextResolver: ContextResolver;
  contextContracts: ContextContractStore;
  contextSources: ContextSourceProvider;
  repositoryReader: RepositoryReader;
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
  ...createRefinementActivities({
    refinement: dependencies.refinement,
    logger: dependencies.logger,
  }),
  ...createContextActivities({
    resolver: dependencies.contextResolver,
    contracts: dependencies.contextContracts,
    runs: dependencies.runs,
    logger: dependencies.logger,
    sources: dependencies.contextSources,
    repositoryReader: dependencies.repositoryReader,
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
