import type { HostCredentialAccess } from "~/domain/products/host-credentials.js";
import type { CredentialBindingStore } from "~/domain/runs/credential-egress.js";
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
import type { ValidationContractStore, ValidationPlanStore } from "~/domain/validation/validation-contract-store.js";
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
import { createSandboxActivities, type ProviderFailover } from "./sandbox.activities.js";
import { createProviderSelectionActivities } from "./provider-selection.activities.js";
import type { SandboxProviderSelector } from "~/domain/runs/provider-selection.js";
import type { BuildAheadFailureStore } from "~/domain/runs/build-ahead.js";
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
import { createDraftActivities } from "./draft.activities.js";
import type { RunDraftStore } from "~/domain/runs/run-draft.js";
import { createIssueStatusActivities } from "./issue-status.activities.js";
import type { IssueStatusPort } from "~/domain/runs/issue-status.js";
import { createPullRequestActivities } from "./pull-request.activities.js";
import type { DeployPort } from "~/domain/pull-requests/deploys.js";
import type { ChangeSetStore, CommitStatusPort } from "~/domain/pull-requests/change-set-status.js";
import type { PullRequestStore } from "~/domain/pull-requests/pull-request-store.js";
import type { PullRequestReviewPort } from "~/domain/pull-requests/pr-follow-up.js";
import type { AutoMergePort } from "~/domain/pull-requests/auto-merge.js";
import type { PullRequestCloseHandler } from "~/domain/runs/pull-request-close.js";
import {
  createSkillRegistryActivities,
  type OrganizationSkillsFactory,
  type SkillRegistryFactory,
} from "./skill-registry.activities.js";

export interface ActivityDependencies {
  /** docs/specs/host-credentials.md. The host credentials of each product. Absent means none. */
  hostCredentials?: {
    access: (tenantId: string, productId: string, checkoutRepositories: readonly string[]) => Promise<HostCredentialAccess>;
    hosts: (tenantId: string, productId: string) => Promise<string[]>;
    key: (tenantId: string, productId: string) => Promise<string[]>;
    bindings: CredentialBindingStore;
  };
  runs: RunRepository;
  /** docs/specs/release-0-1-0.md, DI-15.13. The maxConcurrentRuns slots of each Product. */
  runSlots: RunSlots;
  products: ProductRegistry;
  repositories: RepositoryRegistry;
  agentSession: AgentSessionPort;
  workItems: WorkItemPort;
  sandboxManager: SandboxManager;
  sandbox: Sandbox;
  /**
   * docs/specs/sandbox-provider-spillover.md. Picks the sandbox provider of a run or a setup. A
   * worker without it runs every sandbox on the default provider.
   */
  providerSelector?: SandboxProviderSelector | undefined;
  failover?: ProviderFailover | undefined;
  /** The ids of the enabled sandbox providers whose adapter builds. A build-ahead builds on each. */
  sandboxProviderIds?: (() => Promise<string[]>) | undefined;
  buildAheadFailures?: BuildAheadFailureStore | undefined;
  /** The name of a sandbox provider, for the proof pack. */
  sandboxProviderName?: ((providerId: string) => Promise<string | null>) | undefined;
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
  /** docs/specs/pr-review-merge-and-deploy.md, D1. The passing Validation Plans and the contract adoption. */
  validationPlans?: ValidationPlanStore | undefined;
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
  /**
   * docs/specs/draft-of-failed-run.md. The facts and the record of a draft of a failed run. A
   * worker without it refuses every draft and offers none.
   */
  drafts?: RunDraftStore | undefined;
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
  /**
   * docs/specs/pr-review-merge-and-deploy.md. The published pull requests, and the close that moves
   * the issue of the origin run. A worker without them records no pull request, so the run starts no
   * PR workflow.
   */
  publishedPullRequests?: PullRequestStore | undefined;
  pullRequestClose?: Pick<PullRequestCloseHandler, "closeOfRecord" | "afterFailedDeploy"> | undefined;
  /** docs/specs/pr-review-merge-and-deploy.md. The GitHub calls of the L4 merge. A worker without them turns on no auto-merge. */
  autoMerge?: AutoMergePort | undefined;
  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 3. The review reads and replies of the PR
   * follow-up runs. A worker without them starts no PR follow-up run.
   */
  pullRequestReviews?: PullRequestReviewPort | undefined;
  /** docs/specs/pr-review-merge-and-deploy.md, slice 5. The deploy reads. A worker without them reports no deploy. */
  deploys?: DeployPort | undefined;
  /** docs/specs/change-sets.md, slices 8 and 9. The pull requests of a change set. A worker without them knows no set. */
  changeSets?: ChangeSetStore | undefined;
  /** docs/specs/change-sets.md, slice 8. The `factoree/change-set` commit status. A worker without it sets none. */
  commitStatuses?: CommitStatusPort | undefined;
  /** The product page of the Factoree UI, which a missing-host post names. */
  productPageUrl?: ((productId: string) => string) | undefined;
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

/** A worker built without the draft store knows no run, so it refuses every draft and offers none. */
const NO_DRAFT_STORE: RunDraftStore = {
  facts: () => Promise.resolve(null),
  subject: () => Promise.resolve(null),
  recordRequest: () => Promise.reject(new Error("this worker holds no draft store")),
  markPublished: () => Promise.reject(new Error("this worker holds no draft store")),
};

/** A worker built without the pull request store records no pull request and takes no event. */
const NO_PULL_REQUEST_STORE: PullRequestStore = {
  recordPublished: () => Promise.reject(new Error("this worker holds no pull request store")),
  find: () => Promise.reject(new Error("this worker holds no pull request store")),
  findByNumber: () => Promise.reject(new Error("this worker holds no pull request store")),
  findByCommit: () => Promise.reject(new Error("this worker holds no pull request store")),
  recordEvent: () => Promise.reject(new Error("this worker holds no pull request store")),
  markClosed: () => Promise.reject(new Error("this worker holds no pull request store")),
  steeringFacts: () => Promise.reject(new Error("this worker holds no pull request store")),
  setAutoMerge: () => Promise.reject(new Error("this worker holds no pull request store")),
  listAutoMergeUnavailable: () => Promise.reject(new Error("this worker holds no pull request store")),
  originFacts: () => Promise.reject(new Error("this worker holds no pull request store")),
  markReviewerHandled: () => Promise.reject(new Error("this worker holds no pull request store")),
  countReviewerFollowUp: () => Promise.reject(new Error("this worker holds no pull request store")),
  markBringCurrentTried: () => Promise.reject(new Error("this worker holds no pull request store")),
  listOpenByBase: () => Promise.reject(new Error("this worker holds no pull request store")),
  listEvents: () => Promise.reject(new Error("this worker holds no pull request store")),
  listMergedForDeploy: () => Promise.reject(new Error("this worker holds no pull request store")),
  listDeploys: () => Promise.reject(new Error("this worker holds no pull request store")),
  recordDeploy: () => Promise.reject(new Error("this worker holds no pull request store")),
  setDeployIssueMove: () => Promise.reject(new Error("this worker holds no pull request store")),
  openDeployFailure: () => Promise.reject(new Error("this worker holds no pull request store")),
  markDeployFollowedUp: () => Promise.reject(new Error("this worker holds no pull request store")),
};

const NO_REVIEWS_REASON = "this worker holds no GitHub review port";

/** A worker built without the review port starts no PR follow-up run, and the PR workflow logs it. */
const NO_REVIEWS: PullRequestReviewPort = {
  reviewerFindings: () => Promise.reject(new Error(NO_REVIEWS_REASON)),
  review: () => Promise.reject(new Error(NO_REVIEWS_REASON)),
  canWrite: () => Promise.reject(new Error(NO_REVIEWS_REASON)),
  reply: () => Promise.reject(new Error(NO_REVIEWS_REASON)),
  comment: () => Promise.reject(new Error(NO_REVIEWS_REASON)),
};

const NO_AUTO_MERGE_REASON = "this worker holds no GitHub auto-merge port";

/** A worker built without the auto-merge port refuses the L4 merge, and the PR workflow logs it. */
const NO_AUTO_MERGE: AutoMergePort = {
  pullRequest: () => Promise.reject(new Error(NO_AUTO_MERGE_REASON)),
  gate: () => Promise.reject(new Error(NO_AUTO_MERGE_REASON)),
  reviewerVerdict: () => Promise.reject(new Error(NO_AUTO_MERGE_REASON)),
  reviews: () => Promise.reject(new Error(NO_AUTO_MERGE_REASON)),
  enable: () => Promise.reject(new Error(NO_AUTO_MERGE_REASON)),
  disable: () => Promise.reject(new Error(NO_AUTO_MERGE_REASON)),
  behindBy: () => Promise.reject(new Error(NO_AUTO_MERGE_REASON)),
  merge: () => Promise.reject(new Error(NO_AUTO_MERGE_REASON)),
};

const NO_DEPLOYS_REASON = "this worker holds no GitHub deployment port";

/** A worker built without the deployment port reports no deploy, and the PR workflow logs it. */
const NO_DEPLOYS: DeployPort = {
  contains: () => Promise.reject(new Error(NO_DEPLOYS_REASON)),
  previousSuccess: () => Promise.reject(new Error(NO_DEPLOYS_REASON)),
};

const NO_CHANGE_SETS_REASON = "this worker holds no change set store";

/** A worker built without the change set store refuses every set read. */
const NO_CHANGE_SETS: ChangeSetStore = {
  changeSetOfPullRequest: () => Promise.reject(new Error(NO_CHANGE_SETS_REASON)),
  changeSetOfRun: () => Promise.reject(new Error(NO_CHANGE_SETS_REASON)),
  markChangeSetStatus: () => Promise.reject(new Error(NO_CHANGE_SETS_REASON)),
  changeSetLock: () => Promise.reject(new Error(NO_CHANGE_SETS_REASON)),
  acquireChangeSetLock: () => Promise.reject(new Error(NO_CHANGE_SETS_REASON)),
  releaseChangeSetLock: () => Promise.reject(new Error(NO_CHANGE_SETS_REASON)),
  recordCheckedHead: () => Promise.reject(new Error(NO_CHANGE_SETS_REASON)),
};

/** A worker built without the commit status port sets no `factoree/change-set` status. */
const NO_COMMIT_STATUSES: CommitStatusPort = {
  setStatus: () => Promise.reject(new Error("this worker holds no GitHub commit status port")),
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
    failover: dependencies.failover,
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
    evidence: dependencies.evidence,
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
    plans: dependencies.validationPlans,
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
    sandboxProviderName: dependencies.sandboxProviderName,
  }),
  ...createIssueStatusActivities({
    runs: dependencies.runs,
    issues: dependencies.issueStatus ?? (() => Promise.reject(new Error("this worker holds no Linear issue status port"))),
    agentSession: dependencies.agentSession,
    logger: dependencies.logger,
  }),
  ...createDraftActivities({
    drafts: dependencies.drafts ?? NO_DRAFT_STORE,
    runs: dependencies.runs,
    agentSession: dependencies.agentSession,
    repositoryBaseUrl: dependencies.repositoryBaseUrl,
    redactor: dependencies.redactor,
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
    providerSelector: dependencies.providerSelector,
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
    hostCredentials: dependencies.hostCredentials?.access,
    credentialBindings: dependencies.hostCredentials?.bindings,
    credentialHosts: dependencies.hostCredentials?.hosts,
    repositories: dependencies.repositories,
  }),
  ...createAppChangeActivities({
    setups: dependencies.setups ?? NO_SETUP_STORE,
    appChangeIssues: dependencies.appChangeIssues ?? NO_APP_CHANGE_STORE,
    products: dependencies.products,
    linearIssues: dependencies.linearIssues ?? (() => Promise.reject(new Error("this worker holds no Linear issue port"))),
    pullRequestState: dependencies.pullRequestState ?? (() => Promise.reject(new Error("this worker holds no pull request reader"))),
    logger: dependencies.logger,
  }),
  ...createProviderSelectionActivities({
    selector: dependencies.providerSelector,
    runs: dependencies.runs,
    products: dependencies.products,
    repositories: dependencies.repositories,
    discoveryClient: dependencies.discoveryClient,
    logger: dependencies.logger,
  }),
  ...createBuildAheadActivities({
    sandboxManager: dependencies.sandboxManager,
    providerIds: dependencies.sandboxProviderIds,
    failures: dependencies.buildAheadFailures,
    products: dependencies.products,
    repositories: dependencies.repositories,
    discoveryClient: dependencies.discoveryClient,
    secrets: dependencies.secrets,
    tokens: dependencies.tokens,
    redactor: dependencies.redactor,
    repositoryBaseUrl: dependencies.repositoryBaseUrl,
    logger: dependencies.logger,
    setupMarks: dependencies.setupMarks,
    credentialKey: dependencies.hostCredentials?.key,
  }),
  ...createPullRequestActivities({
    pullRequests: dependencies.publishedPullRequests ?? NO_PULL_REQUEST_STORE,
    close: dependencies.pullRequestClose ?? {
      closeOfRecord: () => Promise.reject(new Error("this worker holds no pull request close handler")),
      afterFailedDeploy: () => Promise.reject(new Error("this worker holds no pull request close handler")),
    },
    logger: dependencies.logger,
    autoMerge: dependencies.autoMerge ?? NO_AUTO_MERGE,
    products: dependencies.products,
    agentSession: dependencies.agentSession,
    reviews: dependencies.pullRequestReviews ?? NO_REVIEWS,
    repositories: dependencies.repositories,
    workItems: dependencies.workItems,
    repositoryBaseUrl: dependencies.repositoryBaseUrl,
    productPageUrl: dependencies.productPageUrl,
    deploys: dependencies.deploys ?? NO_DEPLOYS,
    changeSets: dependencies.changeSets ?? NO_CHANGE_SETS,
    commitStatuses: dependencies.commitStatuses ?? NO_COMMIT_STATUSES,
  }),
});

export type Activities = ReturnType<typeof createActivities>;
