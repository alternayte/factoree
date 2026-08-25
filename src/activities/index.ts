import type { Logger } from "~/telemetry/logger.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { AgentSessionPort, WorkItemPort } from "~/domain/runs/ports.js";
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
import type { ValidationContractStore } from "~/domain/validation/validation-contract-store.js";
import type { ContextSourceProvider } from "~/domain/context/context-source-provider.js";
import type { RepositoryReader } from "~/adapters/github/git-repository-reader.js";
import type { BrowserDriver } from "~/domain/validation/browser-driver.js";
import type { HttpValidationFetch } from "~/domain/validation/http-validation.js";
import type { ReadinessProbe } from "~/domain/runs/preview.js";
import type { EvidenceStorage } from "~/domain/evidence/evidence-storage.js";
import type { ValidationResultStore } from "~/domain/validation/validation-result-store.js";
import type { ReviewFindingStore } from "~/domain/review/review-finding-store.js";
import { createRunActivities } from "./run.activities.js";
import { createLinearActivities } from "./linear.activities.js";
import { createSandboxActivities } from "./sandbox.activities.js";
import { createAgentActivities } from "./agent.activities.js";
import { createVerificationActivities } from "./verification.activities.js";
import { createRefinementActivities } from "./refinement.activities.js";
import { createContextActivities } from "./context.activities.js";
import { createValidationActivities } from "./validation.activities.js";
import { createEvidencePersistence } from "./evidence.activities.js";
import { createReviewActivities } from "./review.activities.js";

export interface ActivityDependencies {
  runs: RunRepository;
  agentSession: AgentSessionPort;
  workItems: WorkItemPort;
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
  validationContracts: ValidationContractStore;
  repositoryReader: RepositoryReader;
  browser: BrowserDriver;
  httpValidationFetch: HttpValidationFetch;
  previewProbe: ReadinessProbe;
  evidenceStorage: EvidenceStorage;
  validationResults: ValidationResultStore;
  reviewFindings: ReviewFindingStore;
  logger: Logger;
}

export const createActivities = (dependencies: ActivityDependencies) => ({
  ...createRunActivities({ runs: dependencies.runs, logger: dependencies.logger }),
  ...createLinearActivities({ agentSession: dependencies.agentSession, workItems: dependencies.workItems }),
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
  ...createValidationActivities({
    contracts: dependencies.validationContracts,
    runs: dependencies.runs,
    logger: dependencies.logger,
    userValidation: {
      sandbox: dependencies.sandbox,
      runners: dependencies.runners,
      executions: dependencies.executions,
      secrets: dependencies.secrets,
      redactor: dependencies.redactor,
      browser: dependencies.browser,
      fetchImpl: dependencies.httpValidationFetch,
      probe: dependencies.previewProbe,
      evidencePersistence: createEvidencePersistence({
        evidence: dependencies.evidence,
        results: dependencies.validationResults,
        storage: dependencies.evidenceStorage,
        logger: dependencies.logger,
      }),
    },
  }),
  ...createReviewActivities({
    sandbox: dependencies.sandbox,
    runners: dependencies.runners,
    executions: dependencies.executions,
    secrets: dependencies.secrets,
    redactor: dependencies.redactor,
    contracts: dependencies.validationContracts,
    reviewFindings: dependencies.reviewFindings,
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
