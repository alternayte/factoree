import type { RunStatus } from "~/domain/runs/run-status.js";
import type { SkillRegistrySettings } from "~/domain/runs/skill-registry.js";
import type { PrFollowUpInput } from "~/domain/pull-requests/pr-follow-up.js";
import type { BringCurrentInput, BringCurrentOutcome } from "~/domain/pull-requests/bring-current.js";
// The workflow bundler resolves a relative path only, so this type import does not use the
// `~/` alias either. F8. The type lives in the domain layer; the workflow re-exports it, so the
// workflow's own external input type is unaffected.
import type { AgentRunProductRepositoryInput } from "../../domain/runs/product-repository.js";

export type { AgentRunProductRepositoryInput };

export interface AgentRunProductInput {
  productId: string;
  productSlug: string;
  /** The Product default level. Delegation sends L0 for a pending Product. */
  defaultAutonomy: string;
  /** docs/specs/autonomy-levels.md. The risk caps of the Product. Null means the SDD defaults. */
  riskCaps: Record<string, string> | null;
  /** R-4. The egress ceiling of every sandbox of this Product. */
  allowedDomains: string[];
  /** Every repository the Product owns. Target selection picks the targets of the Run from it. */
  repositories: AgentRunProductRepositoryInput[];
  /** Turns an `owner/repo` slug into a clone URL. */
  repositoryBaseUrl: string;
  /**
   * SDD section 15 and SDD section 57. The runtime configuration comes from
   * `.factoree/config.yaml` in the target repository. The Product owns these two values, and a
   * repository must not widen them.
   */
  stagingRead: boolean;
  spriteRetentionHours: number;
  /** SDD section 16. The organization skills repository slug of the Product, or null. */
  organizationSkillsRepository: string | null;
  /** docs/specs/skill-registry.md. Absent in a history recorded before the registry existed. */
  skillRegistry?: SkillRegistrySettings | null;
  /** docs/specs/egress-honesty-and-issue-status.md. The product page of the Factoree UI. */
  productPageUrl?: string;
  /** Issue #39, DI-21.66. The most criteria a refiner proposal may hold. Absent: 20. */
  refinerCriteriaLimit?: number;
}

/** SDD section 7. The Work Item text, exactly as the author wrote it. */
export interface AgentRunWorkItemInput {
  issueId: string | null;
  title: string;
  description: string;
  url: string | null;
  labels: string[];
}

export interface AgentRunWorkflowInput {
  tenantId: string;
  workspaceId: string;
  productId: string;
  linearIssueId: string | null;
  agentSessionId: string;
  autonomyLevel: string;
  maxRunMinutes: number;
  workItem: AgentRunWorkItemInput;
  product: AgentRunProductInput;
  /** docs/specs/run-recovery.md. The failed run this run follows up. Absent for a first run. */
  followUpOfRunId?: string;
  /** docs/specs/retro-agent.md. The human reply that started this follow-up run, so a retro reads it. */
  followUpReply?: string;
  /**
   * docs/specs/run-recovery.md. The browser assertions of the failed run. When the follow-up run
   * freezes none, its proof pack says the reply replaced them and no visual evidence exists.
   */
  followUpBrowserAssertions?: string[];
  /** docs/specs/change-sets.md, DI-21.131. The repository ids of the targets of the followed run. */
  followUpTargets?: string[];
  /** docs/specs/work-item-images-and-links.md. The moment of the delegation, ISO 8601. */
  delegatedAt?: string;
  /** docs/specs/work-item-images-and-links.md. The reply said "ignore the images". */
  ignoreImages?: boolean;
  /** docs/specs/pr-review-merge-and-deploy.md, slice 3, D2. The pull request a PR follow-up run changes. */
  prFollowUp?: PrFollowUpInput;
  /** docs/specs/pr-review-merge-and-deploy.md, slice 4. The pull request a bring-current run updates. */
  bringCurrent?: BringCurrentInput;
  /** Slice 5, DI-21.124. The failed deploy of a follow-up run that a Linear reply started. */
  deployFailure?: DeployFailureInput;
}

/** DI-21.124. The failed deploy a follow-up run starts from. */
export interface DeployFailureInput {
  environment: string;
  sha: string;
  previousSha: string | null;
  logUrl: string | null;
  pullRequestUrl: string;
}

export interface AgentRunWorkflowResult {
  runId: string;
  status: RunStatus;
  /** Slice 4. What a bring-current run did. The PR workflow reads it. Absent for every other run. */
  bringCurrent?: BringCurrentOutcome;
}

export interface RunSnapshot {
  runId: string | null;
  status: RunStatus;
  humanInputs: string[];
  spriteId: string | null;
  /** SDD section 53. The SHA-256 of the latest context resolution of this Run. */
  contextContractVersion: string | null;
  /** SDD section 53. The SHA-256 of the frozen Validation Contract, or null while none is frozen. */
  validationContractVersion: string | null;
  /** SDD section 23. The one question Factoree waits on, or null. */
  openQuestion: string | null;
}
