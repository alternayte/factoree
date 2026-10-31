import type { Logger } from "~/telemetry/logger.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { AgentSessionPort, WorkItemPort } from "~/domain/runs/ports.js";
import type { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import type { SpriteReaper } from "~/domain/runs/sprite-reaper.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import type { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import type { AgentExecutionRepository } from "~/domain/runs/agent-execution.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
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
import type { PullRequestPort } from "~/domain/publishing/pull-request.js";
import type { GitHubTokenProvider } from "~/domain/products/github-token-provider.js";
import type { RepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";
import type { DiscoveryService } from "~/domain/products/discovery-service.js";
import { createRunActivities } from "./run.activities.js";
import { createLinearActivities } from "./linear.activities.js";
import { createSandboxActivities } from "./sandbox.activities.js";
import { createAgentActivities } from "./agent.activities.js";
import { createVerificationActivities } from "./verification.activities.js";
import { createRefinementActivities } from "./refinement.activities.js";
import { createContextActivities } from "./context.activities.js";
import { createValidationActivities } from "./validation.activities.js";
import { createEvidencePersistence, createProofPackActivities } from "./evidence.activities.js";
import { createReviewActivities } from "./review.activities.js";
import { createPublishingActivities } from "./publishing.activities.js";
import { createDiscoveryActivities } from "./discovery.activities.js";

export interface ActivityDependencies {
  runs: RunRepository;
  products: ProductRegistry;
  repositories: RepositoryRegistry;
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
  /** SDD section 46 step 9. The credential of the Project builds the port for each Run. */
  pullRequests: (token: string) => PullRequestPort;
  gitAuthor: { name: string; email: string };
  logger: Logger;
  /**
   * Mints every GitHub installation token Factoree needs: the read-only clone credential, the
   * discovery read, and the write credential of a publish. One provider, one credential path.
   */
  tokens: GitHubTokenProvider;
  /** The read side of repository discovery. `syncInstallationWorkflow` lists an installation's repositories through it. */
  discoveryClient: RepositoryDiscoveryClient;
  /** Turns one repository's `.factoree/config.yaml` declaration into rows. */
  discoveryService: DiscoveryService;
}

export const createActivities = (dependencies: ActivityDependencies) => ({
  ...createRunActivities({
    runs: dependencies.runs,
    logger: dependencies.logger,
    runners: dependencies.runners,
    agentSession: dependencies.agentSession,
  }),
  ...createLinearActivities({ agentSession: dependencies.agentSession, workItems: dependencies.workItems }),
  ...createSandboxActivities({
    sandboxManager: dependencies.sandboxManager,
    sandbox: dependencies.sandbox,
    runs: dependencies.runs,
    reaper: dependencies.reaper,
    secrets: dependencies.secrets,
    redactor: dependencies.redactor,
    runners: dependencies.runners,
    logger: dependencies.logger,
    tokens: dependencies.tokens,
  }),
  ...createAgentActivities({
    runners: dependencies.runners,
    sandbox: dependencies.sandbox,
    executions: dependencies.executions,
    secrets: dependencies.secrets,
    redactor: dependencies.redactor,
    logger: dependencies.logger,
    evidence: dependencies.evidence,
  }),
  ...createRefinementActivities({
    refinement: dependencies.refinement,
    logger: dependencies.logger,
    agent: {
      sandbox: dependencies.sandbox,
      runners: dependencies.runners,
      executions: dependencies.executions,
      secrets: dependencies.secrets,
      redactor: dependencies.redactor,
    },
  }),
  ...createContextActivities({
    resolver: dependencies.contextResolver,
    contracts: dependencies.contextContracts,
    runs: dependencies.runs,
    logger: dependencies.logger,
    sources: dependencies.contextSources,
    repositoryReader: dependencies.repositoryReader,
    secrets: dependencies.secrets,
    tokens: dependencies.tokens,
    redactor: dependencies.redactor,
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
  ...createPublishingActivities({
    sandbox: dependencies.sandbox,
    secrets: dependencies.secrets,
    redactor: dependencies.redactor,
    runs: dependencies.runs,
    pullRequests: dependencies.pullRequests,
    gitAuthor: dependencies.gitAuthor,
    logger: dependencies.logger,
    tokens: dependencies.tokens,
  }),
  ...createProofPackActivities({
    runs: dependencies.runs,
    products: dependencies.products,
    repositories: dependencies.repositories,
    contextContracts: dependencies.contextContracts,
    validationContracts: dependencies.validationContracts,
    validationResults: dependencies.validationResults,
    evidence: dependencies.evidence,
    reviewFindings: dependencies.reviewFindings,
    agentSession: dependencies.agentSession,
    storage: dependencies.evidenceStorage,
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
  ...createDiscoveryActivities({
    discoveryClient: dependencies.discoveryClient,
    discoveryService: dependencies.discoveryService,
    logger: dependencies.logger,
  }),
});

export type Activities = ReturnType<typeof createActivities>;
