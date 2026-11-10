import type { Logger } from "~/telemetry/logger.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { RunSlots } from "~/domain/runs/run-slots.js";
import type { AgentSessionPort, WorkItemPort } from "~/domain/runs/ports.js";
import type { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import type { SpriteReaper } from "~/domain/runs/sprite-reaper.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import type { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import type { AgentExecutionRepository } from "~/domain/runs/agent-execution.js";
import type { AgentSessionStore } from "~/domain/runs/agent-session.js";
import type { RunStageStore } from "~/domain/runs/run-stage.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import type { EvidenceStore } from "~/domain/evidence/evidence.js";
import type { Redactor } from "~/telemetry/redaction.js";
import type { RefinementEngine } from "~/domain/refinement/refinement-engine.js";
import type { ContextResolver } from "~/domain/context/context-resolver.js";
import type { ContextContractStore } from "~/domain/context/context-contract-store.js";
import type { ValidationContractStore } from "~/domain/validation/validation-contract-store.js";
import type { ContextDeliverySourceProvider, ContextSourceProvider } from "~/domain/context/context-source-provider.js";
import type { RepositoryReader } from "~/adapters/github/git-repository-reader.js";
import type { BrowserDriver } from "~/domain/validation/browser-driver.js";
import type { HttpValidationFetch } from "~/domain/validation/http-validation.js";
import type { ReadinessProbe } from "~/domain/runs/preview.js";
import type { EvidenceStorage } from "~/domain/evidence/evidence-storage.js";
import type { ValidationResultStore } from "~/domain/validation/validation-result-store.js";
import type { ReviewFindingStore } from "~/domain/review/review-finding-store.js";
import type { PullRequestPort } from "~/domain/publishing/pull-request.js";
import type { GitHubTokenProvider } from "~/domain/products/github-token-provider.js";
import type { WorkItemContentPort } from "~/domain/context/work-item-content.js";
import type { ContextSourceConfigurationStore } from "~/domain/context/context-source-configuration.js";
import { createWorkItemActivities } from "./work-item.activities.js";
import type { RepositoryDiscoveryClient, RepositoryFileReader } from "~/adapters/github/repository-discovery-client.js";
import type { WarmSnapshotStore } from "~/domain/runs/warm-snapshot.js";
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
import { createBuildAheadActivities } from "./build-ahead.activities.js";
import { createSetupActivities } from "./setup.activities.js";
import { createAppChangeActivities } from "./app-change.activities.js";
import type { AppChangeIssuePort, AppChangeIssueStore } from "~/domain/setup/app-change-issues.js";
import type { RepositorySetupMarks, RepositorySetupStore } from "~/domain/setup/repository-setup.js";
import type { RunSkillStore } from "~/domain/runs/run-skill.js";
import type { RunViewReader } from "~/domain/runs/run-view.js";
import { createRecoveryActivities } from "./recovery.activities.js";
import { createIssueStatusActivities } from "./issue-status.activities.js";
import type { IssueStatusPort } from "~/domain/runs/issue-status.js";
import {
  createSkillRegistryActivities,
  type OrganizationSkillsFactory,
  type SkillRegistryFactory,
} from "./skill-registry.activities.js";

export interface ActivityDependencies {
  runs: RunRepository;
  /** docs/specs/release-0-1-0.md, DI-15.13. The maxConcurrentRuns slots of each Product. */
  runSlots: RunSlots;
  products: ProductRegistry;
  repositories: RepositoryRegistry;
  agentSession: AgentSessionPort;
  workItems: WorkItemPort;
  sandboxManager: SandboxManager;
  sandbox: Sandbox;
  runners: AgentRunnerRegistry;
  executions: AgentExecutionRepository;
  /** docs/specs/agent-session-usage-and-hangs.md. One row per agent session, with its usage. */
  sessions: AgentSessionStore;
  /** docs/specs/run-speed.md. One row per stage of a run. */
  stages?: RunStageStore | undefined;
  secrets: SecretStore;
  evidence: EvidenceStore;
  redactor: Redactor;
  reaper: SpriteReaper;
  refinement: RefinementEngine;
  contextResolver: ContextResolver;
  contextContracts: ContextContractStore;
  contextSources: ContextSourceProvider;
  /** docs/specs/external-context-delivery.md. The configured sources the work sprite delivery reads. */
  contextDelivery?: ContextDeliverySourceProvider | undefined;
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
  gitAuthor: () => Promise<{ name: string; email: string }>;
  logger: Logger;
  /**
   * Mints every GitHub installation token Factoree needs: the read-only clone credential, the
   * discovery read, and the write credential of a publish. One provider, one credential path.
   */
  tokens: GitHubTokenProvider;
  /** The read side of repository discovery. `syncInstallationWorkflow` lists an installation's repositories through it. */
  discoveryClient: RepositoryDiscoveryClient;
  /** docs/specs/setup-speed-and-history.md. Reads the files a setup input key needs. */
  repositoryFiles?: RepositoryFileReader | undefined;
  /** docs/specs/setup-speed-and-history.md. The warm snapshots a setup session sandbox starts from. */
  warmSnapshots?: Pick<WarmSnapshotStore, "find"> | undefined;
  /** Turns one repository's `.factoree/config.yaml` declaration into rows. */
  discoveryService: DiscoveryService;
  /** docs/specs/run-speed.md. The clone URL base of the install, for a build-ahead. */
  repositoryBaseUrl: () => Promise<string>;
  /** docs/specs/skill-registry.md. The skills of each run, and the adapter of each skill source. */
  skills?: RunSkillStore | undefined;
  skillRegistries?: SkillRegistryFactory | undefined;
  organizationSkills?: OrganizationSkillsFactory | undefined;
  /** docs/specs/run-recovery.md. The facts of a failed run, for its failure post. */
  runViews?: RunViewReader | undefined;
  /** docs/specs/repository-setup-and-services.md. The setup rows. */
  setups?: RepositorySetupStore | undefined;
  setupMarks?: RepositorySetupMarks | undefined;
  /** docs/specs/setup-app-change-issues.md. The app-change issues, the Linear port of a tenant, and a pull request state. */
  appChangeIssues?: AppChangeIssueStore | undefined;
  linearIssues?: ((tenantId: string) => Promise<AppChangeIssuePort>) | undefined;
  pullRequestState?: ((slug: string, number: number, githubInstallationId: string) => Promise<"open" | "merged" | "closed" | null>) | undefined;
  /**
   * docs/specs/work-item-images-and-links.md. The Linear and GitHub reads of the comments, the
   * images and the links of an issue, the hosts of the configured sources, and the vision check
   * of the role models. A worker without them reads only the description.
   */
  workItemContent?: WorkItemContentPort | undefined;
  contextConfigurations?: Pick<ContextSourceConfigurationStore, "list"> | undefined;
  vision?: ((tenantId: string, productId: string, imageCount: number) => Promise<string | null>) | undefined;
  /**
   * docs/specs/egress-honesty-and-issue-status.md. The Linear status port of a tenant. A worker
   * without it moves no issue status.
   */
  issueStatus?: ((tenantId: string) => Promise<IssueStatusPort>) | undefined;
}

/** A worker without the work item reads finds no comment, no image and no link. */
const NO_WORK_ITEM_CONTENT: WorkItemContentPort = {
  comments: () => Promise.resolve([]),
  downloadImage: () => Promise.reject(new Error("this worker holds no Linear image reader")),
  linearIssue: () => Promise.reject(new Error("this worker holds no Linear issue reader")),
  github: () => Promise.reject(new Error("this worker holds no GitHub link reader")),
};

const NO_APP_CHANGE_STORE: AppChangeIssueStore = {
  create: () => Promise.reject(new Error("this worker holds no app-change issue store")),
  listForRepository: () => Promise.reject(new Error("this worker holds no app-change issue store")),
  setOutcome: () => Promise.reject(new Error("this worker holds no app-change issue store")),
  latestRun: () => Promise.reject(new Error("this worker holds no app-change issue store")),
};

/** A worker built without the file reader refuses a setup, and runs every other activity. */
const NO_FILE_READER: RepositoryFileReader = {
  readFile: () => Promise.reject(new Error("this worker holds no repository file reader")),
  headSha: () => Promise.reject(new Error("this worker holds no repository file reader")),
};

/** A worker built without the setup store refuses a setup activity, and runs every other one. */
const NO_SETUP_STORE: RepositorySetupStore = {
  create: () => Promise.reject(new Error("this worker holds no setup store")),
  findById: () => Promise.reject(new Error("this worker holds no setup store")),
  latestByProduct: () => Promise.reject(new Error("this worker holds no setup store")),
  previousWithReport: () => Promise.reject(new Error("this worker holds no setup store")),
  latestOpenPullRequest: () => Promise.reject(new Error("this worker holds no setup store")),
  latestEnded: () => Promise.reject(new Error("this worker holds no setup store")),
  listForRepository: () => Promise.reject(new Error("this worker holds no setup store")),
  update: () => Promise.reject(new Error("this worker holds no setup store")),
};

export const createActivities = (dependencies: ActivityDependencies) => ({
  ...createRunActivities({
    runs: dependencies.runs,
    slots: dependencies.runSlots,
    logger: dependencies.logger,
    runners: dependencies.runners,
    agentSession: dependencies.agentSession,
    redactor: dependencies.redactor,
  }),
  ...createLinearActivities({ agentSession: dependencies.agentSession, workItems: dependencies.workItems, redactor: dependencies.redactor }),
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
    stages: dependencies.stages,
    skills: dependencies.skills,
    registries: dependencies.skillRegistries,
    products: dependencies.products,
    contextContracts: dependencies.contextContracts,
    contextDelivery: dependencies.contextDelivery,
    workItemContent: dependencies.workItemContent,
  }),
  ...createWorkItemActivities({
    content: dependencies.workItemContent ?? NO_WORK_ITEM_CONTENT,
    configurations: dependencies.contextConfigurations ?? { list: () => Promise.resolve([]) },
    sources: dependencies.contextDelivery ?? {
      configuredSourcesFor: () => Promise.reject(new Error("this worker holds no configured context source")),
    },
    githubWebUrl: dependencies.repositoryBaseUrl,
    evidence: dependencies.evidence,
    storage: dependencies.evidenceStorage,
    vision: dependencies.vision ?? (() => Promise.resolve(null)),
    logger: dependencies.logger,
    redactor: dependencies.redactor,
  }),
  ...createAgentActivities({
    runners: dependencies.runners,
    sandbox: dependencies.sandbox,
    executions: dependencies.executions,
    sessions: dependencies.sessions,
    stages: dependencies.stages,
    secrets: dependencies.secrets,
    redactor: dependencies.redactor,
    logger: dependencies.logger,
    evidence: dependencies.evidence,
    skills: dependencies.skills,
    registries: dependencies.skillRegistries,
  }),
  ...createRefinementActivities({
    refinement: dependencies.refinement,
    logger: dependencies.logger,
    agent: {
      sandbox: dependencies.sandbox,
      runners: dependencies.runners,
      executions: dependencies.executions,
      sessions: dependencies.sessions,
      stages: dependencies.stages,
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
      sessions: dependencies.sessions,
      stages: dependencies.stages,
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
    sessions: dependencies.sessions,
    stages: dependencies.stages,
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
    stages: dependencies.stages,
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
    sessions: dependencies.sessions,
    storage: dependencies.evidenceStorage,
    secrets: dependencies.secrets,
    redactor: dependencies.redactor,
    logger: dependencies.logger,
    skills: dependencies.skills,
  }),
  ...createIssueStatusActivities({
    runs: dependencies.runs,
    issues: dependencies.issueStatus ?? (() => Promise.reject(new Error("this worker holds no Linear issue status port"))),
    agentSession: dependencies.agentSession,
    logger: dependencies.logger,
  }),
  ...createRecoveryActivities({
    runViews: dependencies.runViews,
    redactor: dependencies.redactor,
    logger: dependencies.logger,
  }),
  ...createSkillRegistryActivities({
    sandbox: dependencies.sandbox,
    secrets: dependencies.secrets,
    redactor: dependencies.redactor,
    logger: dependencies.logger,
    skills: dependencies.skills,
    registries: dependencies.skillRegistries,
    organizationSkills: dependencies.organizationSkills,
  }),
  ...createVerificationActivities({
    sandbox: dependencies.sandbox,
    evidence: dependencies.evidence,
    secrets: dependencies.secrets,
    redactor: dependencies.redactor,
    logger: dependencies.logger,
    stages: dependencies.stages,
  }),
  ...createDiscoveryActivities({
    discoveryClient: dependencies.discoveryClient,
    discoveryService: dependencies.discoveryService,
    logger: dependencies.logger,
  }),
  ...createSetupActivities({
    setups: dependencies.setups ?? NO_SETUP_STORE,
    products: dependencies.products,
    sandbox: dependencies.sandbox,
    runners: dependencies.runners,
    secrets: dependencies.secrets,
    tokens: dependencies.tokens,
    discoveryClient: dependencies.discoveryClient,
    repositoryFiles: dependencies.repositoryFiles ?? NO_FILE_READER,
    warmSnapshots: dependencies.warmSnapshots,
    browser: dependencies.browser,
    previewProbe: dependencies.previewProbe,
    pullRequests: dependencies.pullRequests,
    gitAuthor: dependencies.gitAuthor,
    repositoryBaseUrl: dependencies.repositoryBaseUrl,
    redactor: dependencies.redactor,
    logger: dependencies.logger,
    appChangeIssues: dependencies.appChangeIssues,
  }),
  ...createAppChangeActivities({
    setups: dependencies.setups ?? NO_SETUP_STORE,
    appChangeIssues: dependencies.appChangeIssues ?? NO_APP_CHANGE_STORE,
    products: dependencies.products,
    linearIssues: dependencies.linearIssues ?? (() => Promise.reject(new Error("this worker holds no Linear issue port"))),
    pullRequestState: dependencies.pullRequestState ?? (() => Promise.reject(new Error("this worker holds no pull request reader"))),
    logger: dependencies.logger,
  }),
  ...createBuildAheadActivities({
    sandboxManager: dependencies.sandboxManager,
    products: dependencies.products,
    repositories: dependencies.repositories,
    discoveryClient: dependencies.discoveryClient,
    secrets: dependencies.secrets,
    tokens: dependencies.tokens,
    redactor: dependencies.redactor,
    repositoryBaseUrl: dependencies.repositoryBaseUrl,
    logger: dependencies.logger,
    setupMarks: dependencies.setupMarks,
  }),
});

export type Activities = ReturnType<typeof createActivities>;
