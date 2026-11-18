import {
  ActivityCancellationType,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  ApplicationFailure,
  isCancellation,
  ParentClosePolicy,
  patched,
  startChild,
  TemporalFailure,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import { pullRequestWorkflow } from "./pr.workflow.js";
import type { RunStatus } from "~/domain/runs/run-status.js";
import { readStopRequest, stopResponse, type StopRequest } from "../domain/runs/run-stop.js";
import type { Activities } from "~/activities/index.js";
import type {
  PrepareCheckSandboxActivityOutput,
  PrepareSandboxActivityOutput,
} from "~/activities/sandbox.activities.js";
import type { ImplementActivityOutput } from "~/activities/agent.activities.js";
import type { ProposeRefinementActivityOutput } from "~/activities/refinement.activities.js";
import type { ForYourEyeCriterion } from "~/domain/validation/for-your-eye.js";
import type { VerifyActivityOutput } from "~/activities/verification.activities.js";
import type { UserValidateActivityOutput } from "~/activities/validation.activities.js";
import type { ReviewActivityOutput } from "~/activities/review.activities.js";
import type { ResolveContextActivityOutput } from "~/activities/context.activities.js";
import type { ReadWorkItemContentActivityOutput } from "~/activities/work-item.activities.js";
import type {
  BringCurrentMergeActivityOutput,
  PublishActivityOutput,
  PushBringCurrentMergeActivityOutput,
} from "~/activities/publishing.activities.js";
import type { PublishProofPackActivityOutput } from "~/activities/evidence.activities.js";
import type { RecordedDecision } from "~/domain/refinement/refinement-engine.js";
import type { SkillRegistrySettings } from "~/domain/runs/skill-registry.js";
import type { AgentSessionRef } from "~/domain/runs/agent-runner.js";
import type { AuthorityDomain } from "~/domain/context/authority.js";
import type { RepositoryRecord } from "~/domain/products/repository-registry.js";
// The workflow bundler resolves a relative path only, so this type import does not use the
// `~/` alias either. F8. The type now lives in the domain layer; the workflow re-exports it, so
// the workflow's own external input type is unaffected.
import type { AgentRunProductRepositoryInput } from "../domain/runs/product-repository.js";

export type { AgentRunProductRepositoryInput };

// The workflow bundler resolves a relative path only, so this value import does not use the
// `~/` alias.
import { RUN_CONFIGURATION_ERROR_TYPE } from "../domain/runs/run-configuration-error.js";
import { INTERNAL_ERROR_SENTENCE, withCauseText } from "../domain/runs/failure-cause.js";
// The workflow bundler resolves a relative path only. Both modules import nothing at run time.
import { SANDBOX_PROVIDER_DOWN_TYPE, SANDBOX_SLOT_UNAVAILABLE_TYPE } from "../domain/runs/sandbox-slot-error.js";
import { queuedMessage } from "../domain/runs/run-slots.js";
// The workflow bundler resolves a relative path only, so this value import does not use the
// `~/` alias either.
import { buildRepositoryUrl } from "../domain/products/repository-url.js";
// The workflow bundler resolves a relative path only, so this value import does not use the
// `~/` alias either.
import { renderRisks } from "../domain/refinement/risk.js";
// The workflow bundler resolves a relative path only, so this value import does not use the
// `~/` alias either.
import { completionInvariantFailures, prePublicationFailures } from "../domain/runs/completion-invariant.js";
// The workflow bundler resolves a relative path only, so this value import does not use the
// `~/` alias either.
import {
  inSetOrder,
  matchReplyToCandidates,
  proposeTarget,
  proposeTargets,
  selectTarget,
  selectTargets,
  type TargetSetOutcome,
} from "../domain/routing/select-targets.js";
import { describeDecision, type FactoreeDecision } from "../domain/runs/factoree-decision.js";
import { mergeOrderDecision } from "../domain/runs/merge-order.js";
import { targetResultsSentence } from "../domain/publishing/change-set.js";
// The workflow bundler resolves a relative path only. Both modules import nothing at run time but
// `sandbox.js`, which imports nothing.
import { renderMissingHostsFailure, type EgressFacts, type MissingHost } from "../domain/runs/egress.js";
import { describeSpentRepairBudget } from "../domain/runs/repair-budget.js";
import { allowListCovers } from "../domain/runs/sandbox.js";
import { endsWithoutPullRequest } from "../domain/runs/issue-status.js";
// The workflow bundler resolves a relative path only. The module imports nothing at run time.
import {
  baseUpdateFindingLines,
  findingPlace,
  keptFindingLines,
  renderPrFollowUpDescription,
  type PrSetMember,
  type PrFollowUpInput,
  type TriagedFinding,
} from "../domain/pull-requests/pr-follow-up.js";
import type { TriageActivityOutput } from "~/activities/review.activities.js";
import type { BringCurrentInput, BringCurrentOutcome } from "../domain/pull-requests/bring-current.js";
import { deployFailureFindingLines } from "../domain/pull-requests/deploys.js";
// The workflow bundler resolves a relative path only. The module imports nothing.
import {
  describeAgentRole,
  describeSilenceLimit,
  type AgentSessionRole,
} from "../domain/runs/agent-session.js";

export interface AgentRunProductInput {
  productId: string;
  productSlug: string;
  /** The Product default level. Delegation sends L0 for a pending Product. */
  defaultAutonomy: string;
  /** docs/specs/autonomy-levels.md. The risk caps of the Product. Null means the SDD defaults. */
  riskCaps: Record<string, string> | null;
  /** R-4. The egress ceiling of every sandbox of this Product. */
  allowedDomains: string[];
  /**
   * Every repository the Product owns. Task 10 selects the target repository of the Run from
   * this list. Until then, the workflow treats the first entry as the target.
   */
  repositories: AgentRunProductRepositoryInput[];
  /** Turns an `owner/repo` slug into a clone URL until the Phase 9 GitHub adapter exists. */
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
  /**
   * docs/specs/skill-registry.md. The skill registry of the Product, or null. Absent in a history
   * recorded before the registry existed.
   */
  skillRegistry?: SkillRegistrySettings | null;
  /**
   * docs/specs/egress-honesty-and-issue-status.md. The product page of the Factoree UI, where an
   * operator widens the allow list. Absent in an older history.
   */
  productPageUrl?: string;
  /**
   * Issue #39, DI-21.66. The most criteria a refiner proposal may hold. Absent in an older
   * history, where the activity takes the default of 20.
   */
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
  /**
   * docs/specs/run-recovery.md. The failed run this run follows up. Its reply and facts are in the
   * work item description. Absent for a first run.
   */
  followUpOfRunId?: string;
  /**
   * docs/specs/run-recovery.md. The browser assertions of the failed run. When the follow-up run
   * freezes none, its proof pack says the reply replaced them and no visual evidence exists.
   */
  followUpBrowserAssertions?: string[];
  /**
   * docs/specs/change-sets.md, DI-21.131. The repository ids of the targets of the run this run
   * follows. The follow-up run changes the same set. Absent for a first run, for a run that follows
   * a run with no target, and in an older history.
   */
  followUpTargets?: string[];
  /**
   * docs/specs/work-item-images-and-links.md. The moment of the delegation, ISO 8601. A comment
   * created later is not read. Absent in an older history.
   */
  delegatedAt?: string;
  /**
   * docs/specs/work-item-images-and-links.md. True when the reply that started this follow-up run
   * said "ignore the images". The run freezes that decision and skips the image check.
   */
  ignoreImages?: boolean;
  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 3, D2. The open pull request this PR follow-up
   * run changes, and the review that started it. Absent for every other run.
   */
  prFollowUp?: PrFollowUpInput;
  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 4. The pull request this bring-current run
   * merges its base into. Absent for every other run.
   */
  bringCurrent?: BringCurrentInput;
  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 5, DI-21.124. The failed deploy of a follow-up run
   * that a Linear reply after the failure started. The first implementer attempt takes it as a
   * finding. Absent for every other run.
   */
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
  /**
   * SDD section 53. The SHA-256 of the latest context resolution of this Run. SDD section 21
   * freezes that resolution only after no unresolved conflict remains, so an earlier value is
   * the hash of a draft.
   */
  contextContractVersion: string | null;
  /**
   * SDD section 53. The SHA-256 of the frozen Validation Contract of this Run, or null while no
   * contract is frozen. SDD section 25 makes this value stable once it is set.
   */
  validationContractVersion: string | null;
  /** SDD section 23. The one question Factoree waits on, or null. */
  openQuestion: string | null;
}

/**
 * docs/specs/run-speed.md. The reviewer runs in its own check sprite beside user validation. A Run
 * whose history began before this change replays the serial order.
 */
const PARALLEL_REVIEW_PATCH = "run-speed-parallel-review";
// docs/specs/early-review-sprite.md. The reviewer's check sprite builds while verify runs.
const EARLY_REVIEW_SPRITE_PATCH = "early-review-sprite";

/** A repair start posts one progress line, so a long repair never looks dead in Linear. */
const REPAIR_PROGRESS_PATCH = "repair-progress";

/** docs/specs/run-recovery.md. An unstable-only validation continues to a draft pull request. */
const UNSTABLE_ASSERTION_PATCH = "unstable-assertion";

/** docs/specs/run-recovery.md. A failed run posts what blocked it and how to reply. */
const FAILURE_POST_PATCH = "failure-post";
/** DI-21.32. A configuration failure takes a follow-up, so its post says how to reply. */
const CONFIGURATION_FAILURE_POST_PATCH = "configuration-failure-post";
/** docs/specs/run-failure-detail.md. An internal error posts its cause to the agent session. */
const INTERNAL_ERROR_POST_PATCH = "internal-error-post";

/**
 * docs/specs/work-item-images-and-links.md. The run reads the comments, the images and the links
 * of the issue before refinement. A history that began before this change reads none.
 */
const WORK_ITEM_CONTENT_PATCH = "work-item-content";

/** The question the "ignore the images" reply answers. Its ref is `linear:decision:work-item-images`. */
const IGNORE_IMAGES_DECISION = {
  questionId: "work-item-images",
  question:
    "The issue holds images, and a role model of this product cannot read an image. Must the run check that every agent can see the images?",
} as const;

/** docs/specs/skill-registry.md. Skill proposals and the run outcome reach the skill sources. */
const SKILL_REGISTRY_PATCH = "skill-registry-signals";

/**
 * docs/specs/egress-honesty-and-issue-status.md. The run moves its issue to started, and back when
 * it ends with no pull request. A history that began before this change moves nothing.
 */
const ISSUE_STATUS_PATCH = "issue-status";
/** docs/specs/egress-honesty-and-issue-status.md. A new pull request links to the issue at once. */
const PULL_REQUEST_LINK_PATCH = "pull-request-link";
/** DI-21.56. A wait for a sandbox slot moves the deadline, as a wait in QUEUED already does. */
const SANDBOX_SLOT_WAIT_PATCH = "sandbox-slot-wait";
/**
 * docs/specs/sandbox-provider-spillover.md. The run selects its sandbox provider and holds its slots
 * there before the work sprite. An older history prepares on the default provider.
 */
const SANDBOX_PROVIDER_PATCH = "sandbox-provider-spillover";
/**
 * docs/specs/draft-of-failed-run.md. After the failure post of a qualifying run, Factoree offers its
 * last patch as a draft pull request. An older history posts no offer.
 */
const DRAFT_OFFER_PATCH = "draft-offer";
/**
 * docs/specs/provider-unreachable.md. A session that cannot reach the model provider is retried
 * up to twice, then ends the Run with PROVIDER_UNREACHABLE. A failure message names the agent's
 * own error. An older history takes the paths from before.
 */
const PROVIDER_UNREACHABLE_PATCH = "provider-unreachable";
/**
 * docs/specs/pr-review-merge-and-deploy.md. Publication records the pull request and starts its PR
 * workflow. An older history starts none, and its close takes the webhook path of DI-21.51.
 */
const PR_WORKFLOW_PATCH = "pr-workflow";
/**
 * docs/specs/change-sets.md. The run selects a set of target repositories, and a follow-up run takes
 * the set of the run it follows. An older history selects one target.
 */
const CHANGE_SET_PATCH = "change-sets";

/**
 * docs/specs/change-sets.md, slice 5. The refiner can add a target and cite edges, the work sprite
 * prepares again for an added target, and an implementer that names another repository gets a
 * not-built decision. An older history adds nothing after the refiner.
 */
const CHANGE_SET_REFINER_PATCH = "change-set-refiner-targets";
/**
 * docs/specs/change-sets.md, DI-21.143. A target the refiner adds resolves the context again for the
 * whole set, and freezes a new Context Contract revision that lists every target.
 */
const CHANGE_SET_CONTEXT_PATCH = "change-set-context-refreeze";
/**
 * docs/specs/change-sets.md, slice 7, DI-21.151. A change set that passes publishes all or nothing:
 * preflight every target, push and open each pull request, write each body with the sibling links,
 * and undo the opened part on a permanent failure. An older history ends PUBLICATION_FAILED before
 * publication, as DI-21.134 did.
 */
const CHANGE_SET_PUBLICATION_PATCH = "change-set-publication";

/**
 * docs/specs/change-sets.md, slice 8. A set publication sets the `factoree/change-set` status of each
 * consumer pull request. An older history sets none.
 */
const CHANGE_SET_STATUS_PATCH = "change-set-status";

/** docs/specs/change-sets.md, slice 7. One target whose pull request opened. */
interface PublishedTarget {
  repositoryId: string;
  slug: string;
  installationId: string;
  baseBranch: string;
  baseSha: string;
  publication: PublishActivityOutput;
}

/**
 * DI-21.46. The egress facts of one sandbox for an agent prompt, or null for a sandbox prepared
 * before the facts existed. A bootstrap host the agent phase also reaches is no bootstrap-only host.
 */
const egressOf = (prepared: PrepareSandboxActivityOutput): EgressFacts | null => {
  const allowed = prepared.allowedHosts;
  if (allowed === undefined) return null;
  return {
    allowed,
    bootstrapOnly: (prepared.runtime.bootstrapAllowedDomains ?? []).filter((host) => !allowListCovers(allowed, host)).sort(),
  };
};

/**
 * docs/specs/change-sets.md. The targets of a change set for an activity input, or nothing for a
 * sandbox of one target, so an activity of one target gets the input it got before.
 */
const setTargetsInput = (prepared: { targets?: Array<{ repository: string; path: string; baseSha: string }> }) =>
  prepared.targets !== undefined && prepared.targets.length > 1 ? { targets: prepared.targets } : {};

/** docs/specs/run-speed.md. How the reviewer that runs beside user validation ended. */
/** docs/specs/early-review-sprite.md. The build of the reviewer's check sprite of one attempt. */
type ReviewSpriteBuild =
  | { kind: "sprite"; sprite: PrepareCheckSandboxActivityOutput }
  /** The sandbox slot wait ended without a sprite: a stop or the Run deadline. */
  | { kind: "unavailable" }
  | { kind: "error"; error: unknown };

type ReviewBranchOutcome =
  | { kind: "review"; review: ReviewActivityOutput }
  /** The sandbox slot wait or the session ended without a result: a stop or the Run deadline. */
  | { kind: "unavailable" }
  | { kind: "error"; error: unknown };

/**
 * SDD section 50, issue #45. The payload names where the stop came from. It is optional, so a
 * signal with no argument, from an older client or the Temporal CLI, still stops the Run and
 * reads as a Linear stop. Only the text of the final response depends on it, so a replay of a
 * workflow that took the old signal gives the same commands (DI-21.64).
 */
export const stopSignal = defineSignal<[StopRequest?]>("stop");
export const humanInputSignal = defineSignal<[string]>("humanInput");
export const runStatusQuery = defineQuery<RunSnapshot>("runStatus");

const activities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, initialInterval: "1 second", backoffCoefficient: 2 },
});

/**
 * Refinement is a pure computation, so it is fast, and a retry costs nothing. One minute is
 * ample for it.
 */
const refineActivities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3, initialInterval: "1 second", backoffCoefficient: 2 },
});

/**
 * The Validation Contract build is a pure computation plus one database write, so it is fast and
 * a retry costs nothing. One minute is ample for it.
 */
const validationActivities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, initialInterval: "1 second", backoffCoefficient: 2 },
});

/** The longest one context resolution attempt can take. */
const RESOLVE_ATTEMPT_TIMEOUT_MS = 30 * 60_000;

/**
 * Context resolution clones and reads repositories, so it takes minutes. The remaining Run
 * budget bounds it, in the same way it bounds preparation.
 */
const buildContextActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${Math.min(RESOLVE_ATTEMPT_TIMEOUT_MS, budgetMs)} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs} milliseconds`,
    // SDD section 49: a semantic failure must not consume the infrastructure retry policy. A
    // repository reference that resolves to nothing repeats on every attempt, so it fails fast.
    retry: {
      maximumAttempts: 3,
      initialInterval: "5 seconds",
      backoffCoefficient: 2,
      nonRetryableErrorTypes: [RUN_CONFIGURATION_ERROR_TYPE],
    },
  });

/**
 * docs/specs/work-item-images-and-links.md. The read downloads up to 10 images of 10 MiB and
 * follows up to 10 links, so it gets more than the one minute of a Linear call.
 */
const workItemActivities = proxyActivities<Activities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 3, initialInterval: "5 seconds", backoffCoefficient: 2 },
});

/**
 * SDD section 8 and SDD section 23 put no bound on the elicitation loop. An unbounded loop is a
 * workflow that never ends. Five rounds cover a realistic clarification, and then Factoree stops.
 * Refinement and conflict resolution share the five rounds. The Run budget of SDD section 50
 * bounds the loop as well. See DI-4.6.
 */
export const MAX_QUESTION_ROUNDS = 5;

/** The longest one preparation attempt can take. A retry gets its own attempt of this length. */
const PREPARE_ATTEMPT_TIMEOUT_MS = 30 * 60_000;

/**
 * Preparation clones every repository and runs the bootstrap command, so it takes minutes.
 * `scheduleToCloseTimeout` bounds every attempt together, so the retry policy cannot spend more
 * than the remaining Run budget.
 */
const buildSandboxActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${Math.min(PREPARE_ATTEMPT_TIMEOUT_MS, budgetMs)} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs} milliseconds`,
    // SDD section 49: a semantic failure must not consume the infrastructure retry policy. A
    // configuration fault repeats on every attempt, so it fails fast. A full sandbox provider is
    // not a fault: the workflow waits for a slot itself (DI-15.14), so the retry policy must not
    // spend its attempts on it.
    retry: {
      maximumAttempts: 3,
      initialInterval: "5 seconds",
      backoffCoefficient: 2,
      nonRetryableErrorTypes: [RUN_CONFIGURATION_ERROR_TYPE, SANDBOX_SLOT_UNAVAILABLE_TYPE, SANDBOX_PROVIDER_DOWN_TYPE],
    },
  });

/**
 * docs/specs/release-0-1-0.md, DI-15.13. How often a queued Run asks for a slot of its Product.
 * The Linear line changes only when the position changes.
 */
const RUN_SLOT_POLL_MS = 20_000;

/** DI-15.14. How long a Run waits before it asks the sandbox provider for a slot again. */
const SANDBOX_SLOT_POLL_MS = 30_000;

/** Reports whether a failure, or any cause below it, is the full sandbox provider of DI-15.14. */
const isSandboxSlotUnavailable = (error: unknown): boolean => {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof ApplicationFailure && current.type === SANDBOX_SLOT_UNAVAILABLE_TYPE) return true;
  }
  return false;
};

/** docs/specs/sandbox-provider-spillover.md. The work sprite create failed at the provider of the run. */
const isSandboxProviderDown = (error: unknown): boolean => {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof ApplicationFailure && current.type === SANDBOX_PROVIDER_DOWN_TYPE) return true;
  }
  return false;
};

/**
 * Reports whether a failure, or any cause below it, is the configuration error of the domain.
 * Temporal wraps an activity error, so the type appears on a cause rather than on the top error.
 */
const isConfigurationFault = (error: unknown): boolean => {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof ApplicationFailure && current.type === RUN_CONFIGURATION_ERROR_TYPE) return true;
  }
  return false;
};

/**
 * docs/specs/run-failure-detail.md. The error text that names the cause of a failure: the message
 * of the configuration error when the chain holds one, else the innermost message. Temporal wraps
 * an activity error, so the outer failure says only that the activity failed.
 */
const causeOf = (error: unknown): string => {
  let innermost = "";
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof ApplicationFailure && current.type === RUN_CONFIGURATION_ERROR_TYPE) return current.message;
    if (current.message.trim() !== "") innermost = current.message;
  }
  return innermost;
};

/** The fixed sentence of a failed step, then the cause of its error. */
const withCause = (sentence: string, error: unknown): string => withCauseText(sentence, causeOf(error));

/**
 * Maps a publication failure to its SDD failure reason. The error crosses the activity boundary,
 * so the workflow sees the Temporal `ApplicationFailure` shape and must read the type name.
 */
const publicationFailureReasonOf = (
  error: unknown,
): "PATCH_HASH_MISMATCH" | "EMPTY_PATCH" | "PUBLICATION_FAILED" => {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof ApplicationFailure) {
      if (current.type === "PATCH_HASH_MISMATCH") return "PATCH_HASH_MISMATCH";
      if (current.type === "EMPTY_PATCH") return "EMPTY_PATCH";
    }
  }
  return "PUBLICATION_FAILED";
};

/**
 * The margin the Implementer activity keeps after the Run budget ends. It covers the
 * cancellation of the agent process and the write of the AgentExecution row.
 */
const IMPLEMENT_MARGIN_MS = 5 * 60_000;

/** The interval between two heartbeats of the Implementer activity. */
const IMPLEMENT_HEARTBEAT_TIMEOUT_MS = 120_000;

/**
 * The Implementer activity is bounded by the remaining Run budget, not by a fixed timeout, so
 * the maximum Run duration really bounds the Run. The activity heartbeats, so Temporal can
 * deliver a cancellation to it. SDD section 49: a semantic failure must not consume the
 * infrastructure retry policy. The Implementer reports a failed attempt as a result, so one
 * attempt is correct here.
 */
const buildImplementActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${budgetMs + IMPLEMENT_MARGIN_MS} milliseconds`,
    // Every attempt together stays inside the Run budget plus the margin. One attempt is allowed,
    // so the two timeouts agree, and the bound holds even if the retry policy changes.
    scheduleToCloseTimeout: `${budgetMs + IMPLEMENT_MARGIN_MS} milliseconds`,
    heartbeatTimeout: `${IMPLEMENT_HEARTBEAT_TIMEOUT_MS} milliseconds`,
    // The workflow waits for the cancelled activity, so the evidence the agent already produced
    // still reaches the AgentExecution row.
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
  });

/**
 * The User Validator activity runs a fresh agent session against a live preview, the same way
 * the Implementer runs one against the sandbox. SDD section 36 puts it inside the same bounded
 * loop, so it takes the same long-activity options as `buildImplementActivities`: the remaining
 * Run budget bounds it, one attempt is allowed, and a heartbeat lets Temporal deliver a
 * cancellation to the live session.
 */
const buildUserValidateActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${budgetMs + IMPLEMENT_MARGIN_MS} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs + IMPLEMENT_MARGIN_MS} milliseconds`,
    heartbeatTimeout: `${IMPLEMENT_HEARTBEAT_TIMEOUT_MS} milliseconds`,
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
  });

/**
 * The Reviewer activity runs a fresh agent session against the source diff, the same way the
 * User Validator runs one against the preview. SDD section 42 puts it inside the same bounded
 * loop, so it takes the same long-activity options.
 */
const buildReviewActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${budgetMs + IMPLEMENT_MARGIN_MS} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs + IMPLEMENT_MARGIN_MS} milliseconds`,
    heartbeatTimeout: `${IMPLEMENT_HEARTBEAT_TIMEOUT_MS} milliseconds`,
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
  });

/** The longest one verification pass can take. A retry gets its own attempt of this length. */
const VERIFY_ATTEMPT_TIMEOUT_MS = 60 * 60_000;

/**
 * Verification runs the project build and test commands, so it takes minutes. It is bounded by
 * the remaining Run budget. SDD section 49: a semantic failure must not consume the
 * infrastructure retry policy. A failing check is a semantic outcome, and the activity returns
 * it as a result, so a retry here covers only a transport fault.
 */
const buildVerifyActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${Math.min(VERIFY_ATTEMPT_TIMEOUT_MS, budgetMs)} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs} milliseconds`,
    retry: { maximumAttempts: 3, initialInterval: "5 seconds", backoffCoefficient: 2 },
  });

/**
 * SDD section 46. The publication clones the repository, applies the patch, pushes, and calls
 * GitHub. A slow network must not fail it, and every step of it is idempotent, so a retry is
 * safe. DI-9.8 keeps the branch name and the pull request lookup deterministic.
 * SDD section 49 forbids a semantic failure to consume the infrastructure retry policy, so the
 * four semantic types below fail fast.
 */
const publishingActivities = proxyActivities<Activities>({
  startToCloseTimeout: "15 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [
      RUN_CONFIGURATION_ERROR_TYPE,
      "PATCH_HASH_MISMATCH",
      "EMPTY_PATCH",
      "PUBLICATION_FAILED",
    ],
  },
});

/**
 * SDD section 47. The Proof Pack reads five stores and posts one Linear response. It is not a
 * fast activity, and a missing input is the only failure a retry cannot repair.
 */
const proofPackActivities = proxyActivities<Activities>({
  startToCloseTimeout: "5 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1 second",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [RUN_CONFIGURATION_ERROR_TYPE, "PROOF_PACK_INPUT_MISSING"],
  },
});

/**
 * docs/specs/pr-review-merge-and-deploy.md. The replies to the dropped PR reviewer findings make one
 * GitHub call per finding, so they get more than the one minute of a single call.
 */
const pullRequestReplyActivities = proxyActivities<Activities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 3, initialInterval: "5 seconds", backoffCoefficient: 2 },
});

/**
 * docs/specs/pr-review-merge-and-deploy.md, slice 4. The trusted merge of the base clones the
 * repository and sends no heartbeat, so it takes the publication bounds without a heartbeat timeout.
 */
const bringCurrentActivities = proxyActivities<Activities>({
  startToCloseTimeout: "15 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [RUN_CONFIGURATION_ERROR_TYPE, "PATCH_HASH_MISMATCH", "EMPTY_PATCH", "PUBLICATION_FAILED"],
  },
});

// The cancellation of a live Implementer session runs after the Run budget has ended, so it
// needs its own short timeout.
const cancelActivities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3, initialInterval: "1 second", backoffCoefficient: 2 },
});

// The first Implementer attempt of a Run. A later repair loop attempt increments this value, so
// each attempt writes its own AgentExecution row.
const FIRST_IMPLEMENTER_ATTEMPT = 1;
/** docs/specs/provider-unreachable.md. The sessions of one step before the Run ends: the first and two retries. */
const PROVIDER_UNREACHABLE_ATTEMPTS = 3;

/**
 * Specification section 10. Matches a human reply against the ambiguous candidates by whole
 * token, never by substring. `acme/checkout-api` must not match a reply that names
 * `acme/checkout-api-gateway`. It returns null when no candidate matches. It also returns null
 * when more than one candidate matches. A reply that resolves nothing must not guess.
 */
const matchReplyToCandidate = <T extends { fullName: string }>(
  reply: string,
  candidates: T[],
): T | null => {
  // Splits the reply on whitespace. It trims leading and trailing punctuation from each piece.
  // A slash and a hyphen survive the trim, so `org/repo-name` stays one token. Lower case makes
  // the match case-insensitive, so a reply typed in the wrong case still resolves.
  const tokens = reply
    .split(/\s+/)
    .map((token) => token.replace(/^[^\w/]+|[^\w/-]+$/g, "").toLowerCase())
    .filter((token) => token.length > 0);

  // A bare repository name resolves only when one candidate carries it. Two candidates that
  // share a bare name make that name ambiguous, even when only one of them appears in the
  // reply. Case folding can create that same collision, so the owner count uses the folded
  // name too.
  const bareNameOwners = new Map<string, number>();
  for (const candidate of candidates) {
    const bareName = (candidate.fullName.split("/").at(-1) ?? candidate.fullName).toLowerCase();
    bareNameOwners.set(bareName, (bareNameOwners.get(bareName) ?? 0) + 1);
  }

  const matches = candidates.filter((candidate) => {
    const fullName = candidate.fullName.toLowerCase();
    if (tokens.includes(fullName)) return true;
    const bareName = (candidate.fullName.split("/").at(-1) ?? candidate.fullName).toLowerCase();
    return tokens.includes(bareName) && bareNameOwners.get(bareName) === 1;
  });

  return matches.length === 1 ? (matches[0] ?? null) : null;
};

export async function agentRunWorkflow(
  input: AgentRunWorkflowInput,
): Promise<AgentRunWorkflowResult> {
  let runId: string | null = null;
  let status: RunStatus = "RECEIVED";
  const humanInputs: string[] = [];
  let stopRequested = false;
  /** Issue #45. Where the first stop came from, or null for a stop with no payload. */
  let stopRequest: StopRequest | null = null;
  let sprite: PrepareSandboxActivityOutput | null = null;
  // docs/specs/check-isolation.md. The check sprite of the current attempt. Verification, user
  // validation, review and publication run there, never in the sprite the Implementer used.
  let checkSandbox: PrepareCheckSandboxActivityOutput | null = null;
  // docs/specs/change-sets.md, DI-21.141, DI-21.149. The cited provider-to-consumer edges of the run,
  // which the in-between check reads.
  let runEdges: Array<{ provider: string; consumer: string }> = [];
  // docs/specs/run-speed.md. The check sprite of the reviewer of the current attempt, and the
  // reviewer that runs beside user validation.
  let reviewSandbox: PrepareCheckSandboxActivityOutput | null = null;
  // docs/specs/early-review-sprite.md. The reviewer's check sprite build of the current attempt,
  // with the destroy that follows a failed verify. The next build and the end of the Run wait for
  // it, so the Run knows every sprite it built.
  let reviewBuild: Promise<unknown> | null = null;
  let liveReview: { scope: CancellationScope; branch: Promise<ReviewBranchOutcome> } | null = null;
  let implementerSession: AgentSessionRef | null = null;
  // docs/specs/skill-registry.md. The skill sources of the Run, once the work sprite exists, and
  // the facts its outcome report needs.
  let skillSources: {
    skillRegistry: SkillRegistrySettings | null;
    organizationSkills: { slug: string; repository: { url: string; ref: string } } | null;
    githubInstallationId: string;
  } | null = null;
  let skillProposalsSent = false;
  let signalRepairs = 0;
  let signalReviewVerdict: string | null = null;
  /** True once the implement activity itself has cancelled the live session. */
  let implementerCancelled = false;
  /** SDD section 23. Every answer a human gave to a question Factoree asked in this Run. */
  const decisions: RecordedDecision[] = [];
  /** docs/specs/own-proposals-and-parallel-runs.md. Every proposal Factoree took without asking. */
  const factoreeDecisions: FactoreeDecision[] = [];
  let openQuestion: string | null = null;
  let contextContractVersion: string | null = null;
  let validationContractVersion: string | null = null;
  // docs/specs/by-eye-criteria-and-selector-recheck.md. The criteria a person judges by eye, from
  // the refiner gate. Each validation pass captures their screenshots, and the Proof Pack shows them.
  let forYourEye: ForYourEyeCriterion[] = [];
  let questionRounds = 0;
  /** DI-21.50. True once this run moved, or tried to move, its issue to started. */
  let issueStatusTracked = false;
  // docs/specs/pr-review-merge-and-deploy.md, slice 3. The pull request a PR follow-up run changes.
  const prFollowUp = input.prFollowUp ?? null;
  // The work item text the run refines. A PR follow-up run adds the review to it.
  let workItemDescription =
    prFollowUp !== null && prFollowUp.trigger !== "reviewer"
      ? renderPrFollowUpDescription({ description: input.workItem.description, followUp: prFollowUp, kept: [] })
      : input.workItem.description;
  // The findings the first implementer attempt repairs: the PR reviewer findings the triage kept.
  // Slice 4. A base update names the conflict or the failed check at once.
  let initialRepairFindings: string[] = prFollowUp?.baseUpdate === undefined ? [] : baseUpdateFindingLines(prFollowUp.baseUpdate);
  // Slice 5, DI-21.124. A reply after a failed deploy hands the failure to the first attempt.
  if (input.deployFailure !== undefined) initialRepairFindings = [...initialRepairFindings, ...deployFailureFindingLines(input.deployFailure)];
  // docs/specs/pr-review-merge-and-deploy.md, slice 4. The pull request a bring-current run updates.
  const bringCurrent = input.bringCurrent ?? null;
  // docs/specs/change-sets.md, slice 9. The change set that a set PR follow-up run or a set
  // bring-current run holds. Only such an input carries one, so an older history never reaches it.
  const prChangeSet = prFollowUp?.changeSet ?? bringCurrent?.changeSet ?? null;
  const setMemberOf = (slug: string): PrSetMember | null =>
    prChangeSet?.members.find((member) => member.repositoryFullName.toLowerCase() === slug.toLowerCase()) ?? null;
  // DI-21.159. The set check and the in-between check of a set run take the edges of the run that
  // opened the set.
  if (prChangeSet !== null) runEdges = prChangeSet.edges.map((edge) => ({ provider: edge.provider, consumer: edge.consumer }));
  let triagedFindings: TriagedFinding[] = [];
  // DI-19.04. A human review is a decision, as a Linear reply is, so the implementer follows it.
  if (prFollowUp !== null && prFollowUp.trigger === "human") {
    humanInputs.push(
      [
        `${prFollowUp.reviewerLogin ?? "A human"} requested changes on the pull request ${prFollowUp.url}:`,
        ...prFollowUp.findings.map((finding) => `- ${findingPlace(finding)}: ${finding.body}`),
      ].join("\n"),
    );
  }

  // Refinement needs a repository pair before target selection runs, further below. This
  // placeholder feeds Refinement only, and the pass-through echo never reaches the sandbox. The
  // target-selection step corrects `primaryRepositorySlug` once the target is known.
  const targetRepositories = input.product.repositories;
  let primaryRepositorySlug = prFollowUp?.repositoryFullName ?? bringCurrent?.repositoryFullName ?? targetRepositories[0]?.fullName ?? "";
  // Specification section 5. The id of the confirmed target's RunTarget row, so the later steps
  // can record its per-target facts as they become known.
  let primaryRepositoryId = targetRepositories[0]?.id ?? "";
  // The GitHub App installation that grants the target repository. The clone, the discovery
  // read, and the publish all mint against this id, never against a Project secret.
  let primaryRepositoryInstallationId = targetRepositories[0]?.githubInstallationId ?? "";
  // docs/specs/change-sets.md. Every target of the Run, in set order. The first is the primary
  // repository above. Target selection fills it.
  let runTargets: Array<{ id: string; fullName: string; githubInstallationId: string }> = [];
  // Specification section 12. A repository in the Product that is not the target is absent at
  // start. It must reach an agent only through clone_sibling, which the Action Policy gates and
  // which writes an evidence record. This list must therefore never take a value from Product
  // membership. `Project.referenceRepositories` no longer exists (specification section 5,
  // "Removed"); a legitimate reference repository now arrives as an ordinary context source
  // (for example Backstage), a mechanism this list plays no part in.
  const referenceRepositorySlugs: string[] = [];
  const defaultBranchForSlug = (slug: string) =>
    targetRepositories.find((repository) => repository.fullName === slug)?.defaultBranch ?? "main";
  // docs/specs/change-sets.md, DI-21.154. A change set that fails its checks names the result of each
  // target. One target adds nothing to its message.
  const setResultsOf = (results: Parameters<typeof targetResultsSentence>[1]): string => {
    const sentence = targetResultsSentence(runTargets.map((target) => target.fullName), results);
    return sentence === "" ? "" : `${sentence} `;
  };

  setHandler(stopSignal, (request?: StopRequest) => {
    if (!stopRequested) stopRequest = readStopRequest(request);
    stopRequested = true;
  });
  setHandler(humanInputSignal, (body: string) => {
    humanInputs.push(body);
  });
  setHandler(runStatusQuery, () => ({
    runId,
    status,
    humanInputs,
    spriteId: sprite?.spriteId ?? null,
    contextContractVersion,
    validationContractVersion,
    openQuestion,
  }));

  const created = await activities.createRun({
    tenantId: input.tenantId,
    // The Run row tracks the Product this delegation routed to.
    productId: input.productId,
    linearIssueId: input.linearIssueId,
    linearAgentSessionId: input.agentSessionId,
    // docs/specs/run-recovery.md. The id this workflow runs under. A follow-up run shares the agent
    // session of the failed run and has a workflow id of its own.
    temporalWorkflowId: workflowInfo().workflowId,
    autonomyLevel: input.autonomyLevel,
    // docs/specs/run-visibility.md. The run list names the issue.
    workItemTitle: input.workItem.title,
    workItemUrl: input.workItem.url,
    ...(input.followUpOfRunId === undefined ? {} : { followUpOfRunId: input.followUpOfRunId }),
  });
  runId = created.runId;
  // docs/specs/blocked-by-wait.md. A stop cancelled the waiting run before this workflow started.
  // The row is terminal and the stop posted its message, so the workflow ends with no write.
  if (created.ended === true) {
    status = created.status ?? "CANCELLED";
    return { runId: created.runId, status };
  }
  // A const holds the identifier, because narrowing of a let does not survive into a closure.
  const id = created.runId;

  // The Run budget starts here. Every later step reads the remaining time from this deadline, so
  // preparation and implementation consume the same budget as the wait does.
  // `maxRunMinutes` can be a fraction. A whole number of milliseconds, with a floor of one
  // second, keeps every derived Temporal duration valid.
  const runBudgetMs = Math.max(1_000, Math.round(input.maxRunMinutes * 60_000));
  // DI-15.13. A wait in QUEUED is not work, so the deadline moves by the time the Run waited there.
  let deadline = Date.now() + runBudgetMs;
  // DI-21.56. The total wait for a run slot or a sandbox slot. completeRun records it, and the
  // shown duration leaves it out.
  let waitedMs = 0;
  const remainingMs = (): number => Math.max(0, deadline - Date.now());

  // A terminal write must run even when the workflow scope is cancelled, or the Run row stays in
  // a working state while the workflow has already ended.
  const completeRun = (args: Parameters<Activities["completeRun"]>[0]): Promise<void> =>
    CancellationScope.nonCancellable(async () => {
      // docs/specs/run-speed.md. A reviewer that still runs has no use once the Run ends. Its
      // activity cancels its own session, and the workflow waits, so its sprite is known.
      const review = liveReview;
      liveReview = null;
      if (review !== null) {
        review.scope.cancel();
        await review.branch;
      }
      // docs/specs/early-review-sprite.md. A reviewer's check sprite that still builds ends first,
      // so the release below finds it.
      const pendingBuild = reviewBuild;
      reviewBuild = null;
      if (pendingBuild !== null) await pendingBuild;
      for (const check of [checkSandbox, reviewSandbox]) {
        if (check === null) continue;
        // The last check sprites go with the Run. A failed delete is logged by the activity.
        await notify(() =>
          cancelActivities.releaseCheckSandbox({
            runId: id,
            spriteId: check.spriteId,
            adapter: check.adapter,
            workspacePath: check.workspacePath,
          }),
        );
      }
      // docs/specs/skill-registry.md. The proposal leaves the work sprite before the Run ends,
      // whatever the outcome. Neither call can fail the Run.
      const sources = skillSources;
      const work = sprite;
      if (sources !== null && work !== null && patched(SKILL_REGISTRY_PATCH)) {
        if (!skillProposalsSent) await notify(() => sendSkillProposals(sources, work));
      }
      await activities.completeRun({ ...args, waitedMs });
      // DI-21.50. A run that ends with no pull request moves its issue back, while the issue is
      // still in the state the run set. The start already took the patch, so no new marker lands here.
      if (issueStatusTracked && endsWithoutPullRequest(args.status) && publishedPullRequestUrls.length === 0) {
        await notify(() => activities.restoreIssueStatus({ tenantId: input.tenantId, runId: id }));
      }
      if (sources !== null && patched(SKILL_REGISTRY_PATCH)) {
        await notify(() =>
          activities.reportSkillOutcome({
            tenantId: input.tenantId,
            productId: input.productId,
            runId: id,
            ...sources,
            outcome: args.status === "READY_FOR_HUMAN" ? "succeeded" : args.status === "CANCELLED" ? "cancelled" : "failed",
            repairs: signalRepairs,
            reviewVerdict: signalReviewVerdict,
            evidenceUrl: input.workItem.url,
          }),
        );
      }
    });

  const sendSkillProposals = (
    sources: NonNullable<typeof skillSources>,
    work: PrepareSandboxActivityOutput,
  ): Promise<void> =>
    activities.submitSkillProposals({
      tenantId: input.tenantId,
      productId: input.productId,
      runId: id,
      ...sources,
      runLink: input.workItem.url,
      work: {
        spriteId: work.spriteId,
        adapter: work.adapter,
        workspacePath: work.workspacePath,
        primaryPath: work.primaryPath,
      },
    });

  const failRun = async (
    failureReason:
      | "RUN_TIMEOUT"
      | "IMPLEMENTATION_FAILED"
      | "AGENT_HUNG"
      | "PROVIDER_UNREACHABLE"
      | "CONFIGURATION_INVALID"
      | "VERIFICATION_FAILED"
      | "REFINEMENT_UNRESOLVED"
      | "REFINEMENT_UNAVAILABLE"
      | "TARGET_UNRESOLVED"
      | "CONTEXT_UNRESOLVED"
      | "VALIDATION_UNRESOLVED"
      | "VALIDATION_FAILED"
      | "VALIDATION_BLOCKED"
      | "VALIDATION_MANUAL_REQUIRED"
      | "REVIEW_BLOCKING_FINDINGS"
      | "REVIEW_UNAVAILABLE"
      | "PATCH_HASH_MISMATCH"
      | "EMPTY_PATCH"
      | "PUBLICATION_FAILED"
      | "COMPLETION_INVARIANT_UNMET",
    message: string,
  ): Promise<AgentRunWorkflowResult> => {
    // SDD section 50 obligation 1. A Run that ends on its deadline must cancel the active agent
    // process. The implement activity cancels its own live session when a scope cancellation
    // reaches it. The workflow must cancel again only when the activity did not already cancel the session.
    const live = implementerSession;
    if (live !== null && !implementerCancelled) {
      await notify(() =>
        cancelActivities.cancelImplementer({ runnerName: live.runner, session: live }),
      );
    }

    // SDD section 48. A blocking review finding has its own terminal state. Every other reason
    // except a configuration fault ends the Run in `FAILED`.
    status =
      failureReason === "CONFIGURATION_INVALID"
        ? "FAILED_CONFIGURATION"
        : failureReason === "REVIEW_BLOCKING_FINDINGS"
          ? "FAILED_REVIEW"
          : "FAILED";
    // Write the durable terminal state first. A Linear outage must not leave the Run open.
    await completeRun({
      tenantId: input.tenantId,
      runId: id,
      status,
      failureReason,
      failureMessage: message,
      completedAt: new Date(Date.now()).toISOString(),
    });
    // docs/specs/run-recovery.md. A run that can take a follow-up says what blocked it and how
    // to reply. The post falls back to the message when the facts cannot be read.
    let post = message;
    // docs/specs/pr-review-merge-and-deploy.md. A PR follow-up run takes no Linear reply and no
    // draft: the pull request it follows is open already, and a review there starts the next one.
    const kind =
      prFollowUp !== null || bringCurrent !== null
        ? null
        : status === "FAILED" || status === "FAILED_REVIEW"
          ? patched(FAILURE_POST_PATCH)
            ? "run"
            : null
          : status === "FAILED_CONFIGURATION" && patched(CONFIGURATION_FAILURE_POST_PATCH)
            ? "configuration"
            : null;
    if (kind !== null) {
      try {
        post = await activities.describeRunFailure({ tenantId: input.tenantId, runId: id, message, kind });
      } catch (error) {
        if (isCancellation(error)) throw error;
      }
    }
    if (prFollowUp !== null) {
      post =
        `${message}\n\nThis PR follow-up run pushed nothing to ${prFollowUp.url}. Request changes on the pull request, ` +
        "or run the PR reviewer check again, to start another PR follow-up run.";
    }
    if (bringCurrent !== null) post = `${message}\n\nThis bring-current run pushed nothing to ${bringCurrent.url}.`;
    await notify(() => activities.postError({ sessionId: input.agentSessionId, message: post }));
    if (prFollowUp === null && bringCurrent === null && patched(DRAFT_OFFER_PATCH)) {
      await notify(() => activities.offerDraft({ tenantId: input.tenantId, runId: id, sessionId: input.agentSessionId }));
    }
    return { runId: id, status };
  };

  /**
   * docs/specs/agent-session-usage-and-hangs.md. The hang an agent activity reported. An activity
   * result recorded before this field existed carries none, and a replay of that history must
   * take the same path it took then, so an absent field reads as no hang. DI-14.48.
   */
  const hangOf = (output: { hang?: { silenceLimitMs: number } | null } | null): { silenceLimitMs: number } | null =>
    output?.hang ?? null;

  /**
   * docs/specs/provider-unreachable.md. The provider failure an agent activity reported. An older
   * history carries no field, and a replay must read it as none.
   */
  const providerUnreachableOf = (
    output: { providerUnreachable?: { summary: string } | null } | null,
  ): { summary: string } | null => (patched(PROVIDER_UNREACHABLE_PATCH) ? (output?.providerUnreachable ?? null) : null);

  /**
   * docs/specs/provider-unreachable.md. Ends the Run when a role could not reach the model
   * provider on its last retry. The message names the role and the agent's own API error, so the
   * Proof Pack and the Linear post need no look into Temporal.
   */
  const failProviderUnreachable = async (
    role: AgentSessionRole,
    unreachable: { summary: string },
  ): Promise<AgentRunWorkflowResult> =>
    await failRun(
      "PROVIDER_UNREACHABLE",
      `The ${describeAgentRole(role)} session could not reach the model provider ${PROVIDER_UNREACHABLE_ATTEMPTS} times in the same step, ` +
        `so Factoree ended the Run. Provider error: ${unreachable.summary.trim() === "" ? "none reported" : unreachable.summary.trim()} ` +
        "Factoree published nothing.",
    );

  /**
   * docs/specs/provider-unreachable.md. Runs a session again while the provider stays unreachable,
   * at most twice, and returns the last result. The caller decides what a result that is still
   * unreachable means. A retry does not touch the repair budget.
   */
  const retryWhileUnreachable = async <T extends { providerUnreachable?: { summary: string } | null } | null>(
    role: AgentSessionRole,
    first: T,
    again: (retry: number) => Promise<T>,
    // A retry after a hang counts on its own, and its numbers follow those of the first series, so
    // no retry reuses the session key or the files of another.
    retryOffset = 0,
  ): Promise<T> => {
    let result = first;
    for (let retry = 1; retry < PROVIDER_UNREACHABLE_ATTEMPTS; retry += 1) {
      if (providerUnreachableOf(result) === null || stopRequested || remainingMs() === 0) break;
      await notify(() =>
        activities.postProgress({
          sessionId: input.agentSessionId,
          message:
            `The ${describeAgentRole(role)} session could not reach the model provider, ` +
            `so Factoree starts one fresh session (retry ${retry} of ${PROVIDER_UNREACHABLE_ATTEMPTS - 1}).`,
        }),
      );
      result = await again(retryOffset + retry);
    }
    return result;
  };

  /**
   * docs/specs/agent-session-usage-and-hangs.md. One hung session gets one more try, and the
   * human sees that it happened.
   */
  const reportHang = async (role: AgentSessionRole, hang: { silenceLimitMs: number }, next: string): Promise<void> => {
    await notify(() =>
      activities.postProgress({
        sessionId: input.agentSessionId,
        message:
          `The ${describeAgentRole(role)} session wrote no output for ${describeSilenceLimit(hang.silenceLimitMs)}, ` +
          `so Factoree stopped it and ${next}.`,
      }),
    );
  };

  /**
   * Tells the human that a repair starts, why, and what the implementer receives. A repair session
   * can run for many minutes with no other post, and Linear marks such a session stale.
   */
  const announceRepair = async (repair: number, limit: number, reason: string, findings: number): Promise<void> => {
    if (!patched(REPAIR_PROGRESS_PATCH)) return;
    await notify(() =>
      activities.postProgress({
        sessionId: input.agentSessionId,
        message:
          `Factoree starts repair ${repair} of ${limit}, because ${reason}. ` +
          `The implementer receives ${findings} ${findings === 1 ? "finding" : "findings"}. ` +
          "Factoree posts again when it checks the new change.",
      }),
    );
  };

  /**
   * docs/specs/agent-session-usage-and-hangs.md. A second hang in the same step ends the Run. The
   * message names the role and the silence limit, because two hangs are a pattern a human must see.
   */
  const failHung = async (
    role: AgentSessionRole,
    hang: { silenceLimitMs: number },
    reason = "for the second time in the same step",
    hint = "",
  ): Promise<AgentRunWorkflowResult> =>
    await failRun(
      "AGENT_HUNG",
      `The ${describeAgentRole(role)} session wrote no output for ${describeSilenceLimit(hang.silenceLimitMs)} ` +
        `${reason}, so Factoree stopped it and ended the Run. ${hint === "" ? "" : `${hint} `}Factoree published nothing.`,
    );

  /**
   * Specification section 8 and section 17. The routing table used a cached repository row.
   * A repository that claims a different Product at the base commit is a binding problem. Only
   * an operator can settle it. The Run ends here. This status is terminal.
   */
  const endRoutingMismatch = async (
    routedProductSlug: string,
    declaredProductSlug: string,
  ): Promise<AgentRunWorkflowResult> => {
    status = "BLOCKED_ROUTING";
    await completeRun({
      tenantId: input.tenantId,
      runId: id,
      status,
      completedAt: new Date(Date.now()).toISOString(),
    });
    await notify(() =>
      activities.postError({
        sessionId: input.agentSessionId,
        message:
          "Factoree stopped, because the target repository names a different Product at its " +
          `base commit. Routing used "${routedProductSlug}". The repository names ` +
          `"${declaredProductSlug}". An operator must resolve this binding. Factoree published ` +
          "nothing.",
      }),
    );
    return { runId: id, status };
  };

  const timeoutMessage = "Factoree stopped the Run because it reached the maximum Run duration.";

  /**
   * docs/specs/change-sets.md. The pull request URL of each published target, empty while nothing
   * is published. A stop message and a timeout message must not claim that nothing was published
   * once it exists. The
   * Run status does not change, because SDD section 68 forbids a success terminal state before
   * Phase 10 builds the Proof Pack.
   */
  const publishedPullRequestUrls: string[] = [];

  /**
   * SDD section 23 requires one focused question. The workflow asks that question. It waits for
   * exactly one human input. It records the answer against that question. The result is false
   * when the Run must end instead, so every caller must check the result. The remaining Run
   * budget bounds the wait, and a stop signal ends it as well.
   */
  const askAndWait = async (
    questionId: string,
    question: string,
    /**
     * SDD section 23. The conflict subject this question asks about. The answer settles that
     * subject only. A refinement question settles no conflict, so the caller passes no subject.
     */
    subject?: string,
    /**
     * SDD section 22. The authority domain of the conflict. The answer settles that domain with
     * that subject, and no other pair. A refinement question carries no domain.
     */
    domain?: AuthorityDomain,
    /**
     * Specification section 10. The target-selection gate reports `BLOCKED_TARGET` while it
     * waits, not `WAITING_FOR_INPUT`. Every other caller keeps the default.
     */
    waitingStatus: RunStatus = "WAITING_FOR_INPUT",
  ): Promise<boolean> => {
    if (questionRounds >= MAX_QUESTION_ROUNDS) return false;
    // The count is read before the first await. A human can answer as soon as the Run reports
    // the waiting status, which happens before the elicitation reaches Linear. An answer that
    // arrives in that moment answers this question, and the wait does not miss it.
    const answersBefore = humanInputs.length;
    questionRounds += 1;
    openQuestion = question;
    status = waitingStatus;
    await activities.setRunStatus({ runId: id, status });
    await notify(() => activities.postElicitation({ sessionId: input.agentSessionId, question }));

    const answered = await condition(
      () => stopRequested || humanInputs.length > answersBefore,
      remainingMs(),
    );
    openQuestion = null;
    if (!answered || stopRequested) return false;
    // One human input answers the open question only. SDD section 23 permits one question at a
    // time, so the last input belongs to this question.
    decisions.push({
      questionId,
      question,
      answer: humanInputs[humanInputs.length - 1] ?? "",
      ...(subject === undefined ? {} : { subject }),
      ...(domain === undefined ? {} : { domain }),
    });
    return true;
  };

  /**
   * docs/specs/own-proposals-and-parallel-runs.md. Takes a determined proposal without asking. The
   * run records it, Linear shows it as one thought, and the proof pack lists it for the reviewer.
   */
  const takeDecision = async (decision: FactoreeDecision): Promise<void> => {
    factoreeDecisions.push(decision);
    await activities.recordDecision({ tenantId: input.tenantId, runId: id, decision });
    await notify(() => activities.postProgress({ sessionId: input.agentSessionId, message: describeDecision(decision) }));
  };

  /**
   * Run one long agent activity under a stop signal. SDD section 50 requires a stop to reach
   * the live agent process, so the activity runs inside a cancellable scope, and a watcher
   * coroutine cancels that scope when the stop arrives. The result is null when the activity
   * was cancelled. Every long agent stage uses this helper, so the ordering rules below stay
   * the same for all of them.
   */
  const runAgentActivity = async <T>(start: () => Promise<T>): Promise<T | null> => {
    // A stop that arrived before this stage started must not schedule the activity at all.
    // The scope would then be cancelled in the same workflow activation that created it, and
    // the cancel command can race the schedule command at the server. The activity options use
    // `WAIT_CANCELLATION_COMPLETED`, so the workflow would then wait forever for a
    // cancellation report from an activity that no worker ever started.
    if (stopRequested) return null;

    const scope = new CancellationScope({ cancellable: true });
    const running = scope.run(start);
    // The schedule command above must reach the server in its own workflow activation, before
    // any cancel command can follow it. This durable timer blocks the main coroutine, so the
    // schedule command flushes first, and the two commands can never share one activation.
    await sleep(1);
    const watching = scope
      .run(() => condition(() => stopRequested))
      .then(() => {
        scope.cancel();
      })
      .catch(() => undefined);

    let result: T | null = null;
    try {
      result = await running;
    } catch (error) {
      // A cancelled agent activity is the stop path, not a fault. Every other error is a fault.
      if (!isCancellation(error)) throw error;
    } finally {
      // The activity has settled by now. This cancel unblocks the watcher's own pending
      // `condition`, which never settles on its own when no stop arrives. The cancel reaches
      // no live activity. The SDK sends a cancel command only while the activity is still
      // pending, so a cancel after the activity settled produces no command.
      scope.cancel();
      await watching;
    }
    return result;
  };

  /**
   * One Implementer attempt. The session bookkeeping is unchanged from Phase 2. It returns
   * null when the activity was cancelled.
   */
  const runImplementer = async (attemptInput: {
    prepared: PrepareSandboxActivityOutput;
    goal: string;
    attempt: number;
    repairFindings: string[];
    /**
     * SDD section 21 and AT-09. The prompt carries the rendered contract and the
     * required-context lines. No file body reaches it.
     */
    contextContract: string;
    requiredContext: string[];
    /**
     * SDD section 34. The Implementer receives the frozen Validation Contract. SDD section 25
     * denies it the authority to change the contract, which the store enforces, not this prompt.
     */
    validationContract: string;
    /** docs/specs/agent-session-usage-and-hangs.md. The hung session this attempt resumes. */
    continueSession?: AgentSessionRef | null;
  }): Promise<ImplementActivityOutput | null> => {
    const budgetMs = remainingMs();
    const implementActivities = buildImplementActivities(budgetMs);
    const implementation = await runAgentActivity(() =>
      implementActivities.implement({
        runId: id,
        tenantId: input.tenantId,
        productId: input.productId,
        runnerName: attemptInput.prepared.runtime.implementerRunner,
        spriteId: attemptInput.prepared.spriteId,
        adapter: attemptInput.prepared.adapter,
        workspacePath: attemptInput.prepared.workspacePath,
        primaryPath: attemptInput.prepared.primaryPath,
        // docs/specs/change-sets.md. An activity input adds no workflow command.
        ...setTargetsInput(attemptInput.prepared),
        referencePaths: attemptInput.prepared.referencePaths,
        goal: attemptInput.goal,
        contextContract: attemptInput.contextContract,
        validationContract: attemptInput.validationContract,
        requiredContext: attemptInput.requiredContext,
        // docs/specs/external-context-delivery.md. Absent in a history from before the delivery.
        contextFiles: attemptInput.prepared.contextFiles ?? [],
        imageFiles: attemptInput.prepared.imageFiles ?? [],
        // docs/specs/own-proposals-and-parallel-runs.md. The implementer follows Factoree's own
        // decisions as it follows a human answer.
        humanDecisions: [...humanInputs, ...factoreeDecisions.map(describeDecision)],
        repositoryInstructions: attemptInput.prepared.repositoryInstructions,
        skills: attemptInput.prepared.skills,
        // docs/specs/skill-registry.md. The registry hears which skills the session loaded, and
        // the implementer may propose one skill when a source takes it.
        skillRegistry: input.product.skillRegistry ?? null,
        skillProposals: (input.product.skillRegistry ?? null) !== null || input.product.organizationSkillsRepository !== null,
        repairFindings: attemptInput.repairFindings,
        stagingRead: attemptInput.prepared.runtime.stagingRead,
        // docs/specs/implementer-self-check.md. Facts only: the checks Factoree runs, and whether
        // agent-browser is installed. The preview command stays with the check sprite.
        verifyCommands: attemptInput.prepared.verifyCommands,
        selfCheck: attemptInput.prepared.selfCheckReady === true,
        egress: egressOf(attemptInput.prepared),
        timeoutMs: budgetMs,
        attempt: attemptInput.attempt,
        ...((attemptInput.continueSession ?? null) === null ? {} : { continueSession: attemptInput.continueSession }),
      }),
    );

    if (implementation !== null) {
      // The fallback below runs unless the activity itself really cancelled the session. A
      // session lookup that gave up, or a cancel that failed, still needs the fallback.
      implementerCancelled = implementation.cancelledSession;
      implementerSession = {
        sessionId: implementation.sessionId,
        processId: implementation.processId,
        runner: implementation.runner,
      };
    }
    return implementation;
  };

  /**
   * One User Validator pass. SDD section 36 places it inside the same bounded loop the
   * Implementer and deterministic verification use. It shares `runAgentActivity` with
   * `runImplementer`, because the same long-activity options apply. The activity cancels its
   * own live validator session when the scope cancellation reaches it.
   */
  const runUserValidate = async (attemptInput: {
    prepared: PrepareSandboxActivityOutput;
    goal: string;
    attempt: number;
    /** docs/specs/agent-session-usage-and-hangs.md. The one fresh session after a hang. */
    afterHang?: boolean;
    /** docs/specs/provider-unreachable.md. 1 or 2 for the fresh session after an unreachable provider. */
    unreachableRetry?: number;
    /** Slice 4, D1. Replays the stored passing plan of the run with no validator session. */
    replay?: boolean;
  }): Promise<UserValidateActivityOutput | null> => {
    const budgetMs = remainingMs();
    const userValidateActivities = buildUserValidateActivities(budgetMs);
    return await runAgentActivity(() =>
      userValidateActivities.userValidate({
        runId: id,
        tenantId: input.tenantId,
        productId: input.productId,
        runnerName: attemptInput.prepared.runtime.validatorRunner,
        spriteId: attemptInput.prepared.spriteId,
        adapter: attemptInput.prepared.adapter,
        workspacePath: attemptInput.prepared.workspacePath,
        primaryPath: attemptInput.prepared.primaryPath,
        goal: attemptInput.goal,
        preview: attemptInput.prepared.preview,
        timeoutMs: budgetMs,
        attempt: attemptInput.attempt,
        // docs/specs/repository-setup-and-services.md. From the config at the base SHA.
        accounts: attemptInput.prepared.runtime.accounts ?? [],
        // Issue #44, DI-21.68. Absent in a history recorded before the limits existed.
        ...(attemptInput.prepared.runtime.browserLimits === undefined
          ? {}
          : { browserLimits: attemptInput.prepared.runtime.browserLimits }),
        services: attemptInput.prepared.runtime.services ?? null,
        // docs/specs/work-item-images-and-links.md. The images of the check sprite.
        imageFiles: attemptInput.prepared.imageFiles ?? [],
        egress: egressOf(attemptInput.prepared),
        ...(attemptInput.afterHang === true ? { afterHang: true } : {}),
        ...((attemptInput.unreachableRetry ?? 0) > 0 ? { unreachableRetry: attemptInput.unreachableRetry } : {}),
        ...(forYourEye.length === 0 ? {} : { forYourEye }),
        ...(attemptInput.replay === true ? { replay: true } : {}),
        // docs/specs/change-sets.md, slice 6. The set check of a change set: its groups, its edges and
        // the targets whose patch changes a file. An activity input adds no workflow command.
        ...(attemptInput.prepared.setCheck === undefined
          ? {}
          : {
              setCheck: attemptInput.prepared.setCheck,
              edges: runEdges,
              changedTargets: ((attemptInput.prepared as Partial<PrepareCheckSandboxActivityOutput>).checkedTargets ?? [])
                .filter((target) => target.changedFiles.length > 0)
                .map((target) => target.repository),
            }),
      }),
    );
  };

  /**
   * One Reviewer pass. SDD section 40 and section 42. Every pass starts a new session, so no
   * session reference passes between attempts. See DI-8.11.
   */
  const runReview = async (attemptInput: {
    prepared: PrepareSandboxActivityOutput;
    goal: string;
    attempt: number;
    contextContract: string | null;
    constraints: string[];
    verificationSummary: string;
    /** Absent beside user validation (docs/specs/run-speed.md), present on the serial path. */
    validationEvidence?: string[];
    /** docs/specs/agent-session-usage-and-hangs.md. The one fresh session after a hang. */
    afterHang?: boolean;
    /** docs/specs/provider-unreachable.md. 1 or 2 for the fresh session after an unreachable provider. */
    unreachableRetry?: number;
  }): Promise<ReviewActivityOutput | null> => {
    const budgetMs = remainingMs();
    const reviewActivities = buildReviewActivities(budgetMs);
    return await runAgentActivity(() =>
      reviewActivities.review({
        runId: id,
        tenantId: input.tenantId,
        productId: input.productId,
        runnerName: attemptInput.prepared.runtime.reviewerRunner,
        spriteId: attemptInput.prepared.spriteId,
        adapter: attemptInput.prepared.adapter,
        workspacePath: attemptInput.prepared.workspacePath,
        primaryPath: attemptInput.prepared.primaryPath,
        baseSha: attemptInput.prepared.baseSha,
        ...setTargetsInput(attemptInput.prepared),
        goal: attemptInput.goal,
        contextContract: attemptInput.contextContract,
        constraints: attemptInput.constraints,
        verificationSummary: attemptInput.verificationSummary,
        ...(attemptInput.validationEvidence === undefined ? {} : { validationEvidence: attemptInput.validationEvidence }),
        repositoryInstructions: attemptInput.prepared.repositoryInstructions,
        // docs/specs/work-item-images-and-links.md. The images of the reviewer's check sprite.
        imageFiles: attemptInput.prepared.imageFiles ?? [],
        timeoutMs: budgetMs,
        attempt: attemptInput.attempt,
        ...(attemptInput.afterHang === true ? { afterHang: true } : {}),
        ...((attemptInput.unreachableRetry ?? 0) > 0 ? { unreachableRetry: attemptInput.unreachableRetry } : {}),
      }),
    );
  };

  // docs/specs/autonomy-levels.md. An L0 or L1 Run posts its report as the final response and
  // ends REPORTED. By its level it opens no pull request.
  const endReported = async (body: string): Promise<AgentRunWorkflowResult> => {
    status = "REPORTED";
    await completeRun({
      tenantId: input.tenantId,
      runId: id,
      status,
      completedAt: new Date(Date.now()).toISOString(),
    });
    await notify(() => activities.postFinalResponse({ sessionId: input.agentSessionId, body }));
    return { runId: id, status };
  };

  // SDD section 50: a stop must terminate the active agent process, and no change is published.
  const cancelRun = async (): Promise<AgentRunWorkflowResult> => {
    const session = implementerSession;
    // The implement activity cancels its own live session when the scope cancellation reaches
    // it. A second cancellation is needed only for a session the activity did not cancel.
    if (session !== null && !implementerCancelled) {
      await notify(() =>
        cancelActivities.cancelImplementer({ runnerName: session.runner, session }),
      );
    }
    status = "CANCELLED";
    await completeRun({
      tenantId: input.tenantId,
      runId: id,
      status,
      failureReason: "STOPPED_BY_HUMAN",
      completedAt: new Date(Date.now()).toISOString(),
    });
    await notify(() =>
      activities.postFinalResponse({
        sessionId: input.agentSessionId,
        body: stopResponse(stopRequest, publishedPullRequestUrls),
      }),
    );
    return { runId: id, status };
  };

  /**
   * docs/specs/release-0-1-0.md, DI-15.13. The gate before PREPARING. A Run over its Product's
   * maxConcurrentRuns waits in QUEUED. Linear shows its position, and a new line follows only
   * when the position changes. A stop ends the wait, and the Run leaves the queue as CANCELLED.
   * It answers the terminal result of a stopped Run, or null once the Run holds a slot.
   */
  const waitForRunSlot = async (): Promise<AgentRunWorkflowResult | null> => {
    let queuedSince: number | null = null;
    let shownAhead: number | null = null;
    for (;;) {
      const claim = await activities.claimRunSlot({ runId: id });
      if (claim.granted) break;
      if (queuedSince === null) {
        queuedSince = Date.now();
        // The claim wrote QUEUED to the row in the same transaction that counted the queue.
        status = "QUEUED";
      }
      if (claim.ahead !== shownAhead) {
        shownAhead = claim.ahead;
        const message = queuedMessage(claim.ahead);
        await notify(() => activities.postProgress({ sessionId: input.agentSessionId, message }));
      }
      if (await condition(() => stopRequested, RUN_SLOT_POLL_MS)) return await cancelRun();
    }
    if (queuedSince !== null) {
      const waited = Date.now() - queuedSince;
      deadline += waited;
      waitedMs += waited;
    }
    return null;
  };

  /**
   * docs/specs/release-0-1-0.md, DI-15.14. A sandbox preparation that finds the provider at
   * sandboxMaxLive, with no retained sandbox to delete, waits here and asks again. The wait never
   * fails the Run. Only a stop or the Run budget ends it, and then the answer is null.
   */
  const withSandboxSlot = async <T>(prepare: (budgetMs: number) => Promise<T>): Promise<T | null> => {
    let told = false;
    for (;;) {
      if (remainingMs() === 0) return null;
      try {
        return await prepare(remainingMs());
      } catch (error) {
        if (!isSandboxSlotUnavailable(error)) throw error;
      }
      if (!told) {
        told = true;
        await notify(() =>
          activities.postProgress({
            sessionId: input.agentSessionId,
            message:
              "Every sandbox provider this run may use runs its limit of live sandboxes, and none of " +
              "them is retained for inspection. Factoree waits for a free sandbox.",
          }),
        );
      }
      const waitStarted = Date.now();
      const stopped = await condition(() => stopRequested, Math.max(1, Math.min(SANDBOX_SLOT_POLL_MS, remainingMs())));
      // DI-21.56. A wait for a sandbox slot is not work, so it moves the deadline, as a wait in
      // QUEUED does. An older history keeps its budget.
      if (patched(SANDBOX_SLOT_WAIT_PATCH)) {
        const waited = Date.now() - waitStarted;
        deadline += waited;
        waitedMs += waited;
      }
      if (stopped) return null;
    }
  };

  try {
    await activities.acknowledgeSession({
      sessionId: input.agentSessionId,
      message:
        bringCurrent !== null
          ? bringCurrent.reason === "conflict"
            ? `${bringCurrent.url} conflicts with ${bringCurrent.baseBranch}, so Factoree brings it current. It merges the base and checks the merge with no agent.`
            : `${bringCurrent.baseBranch} requires ${bringCurrent.url} to be up to date before the merge, so Factoree brings it current. It merges the base and checks the merge with no agent.`
          : prFollowUp === null
            ? "Factoree accepted the work and started a Run."
            : prFollowUp.trigger === "human"
              ? `${prFollowUp.reviewerLogin ?? "A human"} requested changes on ${prFollowUp.url}, so Factoree started a PR follow-up run.`
              : prFollowUp.trigger === "base"
                ? `Factoree could not bring ${prFollowUp.url} current with ${prFollowUp.baseBranch} on its own, so it started a PR follow-up run.`
                : `The PR reviewer check failed on ${prFollowUp.url}, so Factoree started a PR follow-up run. It triages the findings first.`,
    });

    status = "RECEIVED";
    await activities.setRunStatus({ runId: id, status, startedAt: new Date(Date.now()).toISOString() });

    // docs/specs/egress-honesty-and-issue-status.md, DI-21.49. Started means that Factoree works on
    // the issue. A Linear fault never fails the Run.
    // docs/specs/pr-review-merge-and-deploy.md. A PR follow-up run moves no issue: the run that opened
    // the pull request owns its issue status, and the merge completes it through the record.
    const startedIssueId = input.workItem.issueId;
    if (prFollowUp === null && bringCurrent === null && startedIssueId !== null && patched(ISSUE_STATUS_PATCH)) {
      issueStatusTracked = true;
      await notify(() => activities.startIssueWork({ tenantId: input.tenantId, runId: id, issueId: startedIssueId }));
    }

    // docs/specs/pr-review-merge-and-deploy.md, slice 4, D1, DI-21.117. A bring-current run: Factoree
    // merges the base into the verified head on its trusted checkout, checks the merge in a check
    // sprite against the frozen contract with no agent (verify, then a replay of the passing plan),
    // and pushes the merge commit only after both pass. It takes a run slot and its sandbox slots like
    // any run. A conflict or a failed check pushes nothing, and the PR workflow starts a PR follow-up
    // run with it as a finding.
    if (bringCurrent !== null) {
      const update = bringCurrent;
      const ended = (result: AgentRunWorkflowResult, outcome: BringCurrentOutcome): AgentRunWorkflowResult => ({ ...result, bringCurrent: outcome });
      const endedWithoutOutcome = async (result: Promise<AgentRunWorkflowResult>) => ended(await result, { kind: "ended" });
      if (remainingMs() === 0) return endedWithoutOutcome(failRun("RUN_TIMEOUT", timeoutMessage));
      const stoppedInQueue = await waitForRunSlot();
      if (stoppedInQueue !== null) return ended(stoppedInQueue, { kind: "ended" });
      status = "PREPARING";
      await activities.setRunStatus({ runId: id, status });
      const repository = targetRepositories.find((candidate) => candidate.id === update.repositoryId);
      if (repository === undefined) {
        return endedWithoutOutcome(
          failRun(
            "TARGET_UNRESOLVED",
            `The repository ${update.repositoryFullName} of ${update.url} is no longer part of this product, so Factoree cannot bring it current.`,
          ),
        );
      }
      await activities.recordRunTarget({ tenantId: input.tenantId, runId: id, repositoryId: repository.id, selectionReason: `the repository of ${update.url}` });
      // docs/specs/change-sets.md, slice 9, DI-21.161. A merge that brings one pull request of a set
      // current gets the set check: every other member joins the check sprite, so the run records each.
      const setMembers = update.changeSet?.members ?? null;
      const setRepositories: AgentRunProductRepositoryInput[] = [];
      if (setMembers !== null) {
        for (const member of setMembers) {
          const memberRepository = targetRepositories.find((candidate) => candidate.id === member.repositoryId);
          if (memberRepository === undefined || memberRepository.absentSince !== null) {
            return endedWithoutOutcome(
              failRun(
                "TARGET_UNRESOLVED",
                `The repository ${member.repositoryFullName} of ${member.url} is no longer part of this product, so Factoree cannot check the change set of ${update.url}.`,
              ),
            );
          }
          setRepositories.push(memberRepository);
          if (memberRepository.id !== repository.id) {
            await activities.recordRunTarget({
              tenantId: input.tenantId,
              runId: id,
              repositoryId: memberRepository.id,
              selectionReason: `the change set of ${update.url}`,
            });
          }
        }
      }
      const mergeInput = {
        runId: id,
        tenantId: input.tenantId,
        productId: input.productId,
        repositorySlug: repository.fullName,
        repositoryBaseUrl: input.product.repositoryBaseUrl,
        githubInstallationId: repository.githubInstallationId,
        branch: update.headBranch,
        pullRequestNumber: update.number,
        pullRequestUrl: update.url,
        headSha: update.headSha,
        baseBranch: update.baseBranch,
        contractRevision: update.contractRevision,
      };
      let merge: BringCurrentMergeActivityOutput;
      try {
        merge = await bringCurrentActivities.mergeBaseIntoPullRequest(mergeInput);
      } catch (error) {
        if (isCancellation(error)) throw error;
        if (isConfigurationFault(error)) {
          return endedWithoutOutcome(failRun("CONFIGURATION_INVALID", withCause(`Factoree could not merge ${update.baseBranch} into ${update.url}.`, error)));
        }
        return endedWithoutOutcome(
          failRun(publicationFailureReasonOf(error), withCause(`Factoree could not merge ${update.baseBranch} into ${update.url} on its trusted checkout.`, error)),
        );
      }
      if (merge.kind === "current") {
        return ended(
          await endReported(`${update.url} holds ${update.baseBranch} at ${merge.baseSha.slice(0, 12)} already, so Factoree changed nothing.`),
          { kind: "current" },
        );
      }
      if (merge.kind === "moved") {
        return ended(
          await endReported(`The branch of ${update.url} moved since Factoree read it, so Factoree did not bring it current. The new head gets its own checks.`),
          { kind: "moved" },
        );
      }
      if (merge.kind === "conflict") {
        return ended(
          await endReported(
            [
              "## Bring current",
              "",
              `The merge of ${update.baseBranch} at ${merge.baseSha.slice(0, 12)} into ${update.url} conflicts in ` +
                `${String(merge.conflicts.length)} ${merge.conflicts.length === 1 ? "file" : "files"}, so Factoree pushed nothing. ` +
                "It starts a PR follow-up run that resolves the conflict.",
              "",
              ...merge.conflicts.slice(0, 20).map((file) => `- ${file}`),
              ...(merge.conflicts.length > 20 ? [`- ${String(merge.conflicts.length - 20)} more files`] : []),
            ].join("\n"),
          ),
          { kind: "conflict", baseSha: merge.baseSha, conflicts: merge.conflicts },
        );
      }
      const merged = merge;
      /** A failed check of the clean merge. The PR workflow starts a PR follow-up run with the failure. */
      const checkFailed = async (
        reason: "VERIFICATION_FAILED" | "VALIDATION_FAILED" | "VALIDATION_UNRESOLVED",
        message: string,
        failure: string,
      ): Promise<AgentRunWorkflowResult> =>
        ended(await failRun(reason, `${message} Factoree starts a PR follow-up run that repairs it.`), {
          kind: "failed",
          baseSha: merged.baseSha,
          failure,
        });

      // D1. The run checks the frozen contract of the verified head, as its own.
      const adopted = await validationActivities.adoptValidationContract({ tenantId: input.tenantId, runId: id, fromRunId: update.contractRunId });
      if (adopted === null) {
        return checkFailed(
          "VALIDATION_UNRESOLVED",
          `The run of the verified head of ${update.url} holds no frozen Validation Contract, so Factoree cannot check the merge with no agent.`,
          "Factoree holds no frozen Validation Contract for the verified head, so it could not check the merge with no agent. Run every check on the merge.",
        );
      }
      validationContractVersion = adopted.sha256;
      if (adopted.automatedAssertions > 0 && !adopted.hasPlan) {
        return checkFailed(
          "VALIDATION_UNRESOLVED",
          `The run of the verified head of ${update.url} stored no passing Validation Plan, so Factoree cannot replay the contract with no agent.`,
          "Factoree holds no passing Validation Plan for the verified head, so it could not check the merge with no agent. Run every check on the merge.",
        );
      }

      const checkInput = {
        runId: id,
        tenantId: input.tenantId,
        productId: input.productId,
        primary: { url: buildRepositoryUrl(input.product.repositoryBaseUrl, repository.fullName), ref: merged.baseSha },
        references: [],
        defaults: {
          stagingRead: input.product.stagingRead,
          spriteRetentionHours: input.product.spriteRetentionHours,
          allowedDomains: input.product.allowedDomains,
        },
        environment: {},
        organizationSkills: null,
        githubInstallationId: repository.githubInstallationId,
        skillRegistry: null,
        patchSha256: merged.patchSha256,
      };
      // DI-21.161. The check sprite of a set: the merged target at the new base with the merge patch,
      // each other open member at its verified base with the diff to its head, each merged one at its
      // merge commit. The first target in set order is the primary checkout.
      const setTargets =
        setMembers === null
          ? null
          : inSetOrder(setRepositories).map((memberRepository) => {
              const member = setMembers.find((candidate) => candidate.repositoryId === memberRepository.id);
              const merging = memberRepository.id === repository.id;
              return {
                repository: memberRepository.fullName,
                url: buildRepositoryUrl(input.product.repositoryBaseUrl, memberRepository.fullName),
                ref: merging ? merged.baseSha : (member?.baseSha ?? ""),
                githubInstallationId: memberRepository.githubInstallationId,
                ...(!merging && member?.state === "open" ? { pullRequestHead: member.headSha } : {}),
              };
            });
      const firstSetTarget = setTargets?.[0];
      const checkSpriteInput =
        setTargets === null || firstSetTarget === undefined
          ? checkInput
          : { ...checkInput, primary: { url: firstSetTarget.url, ref: firstSetTarget.ref }, targets: setTargets, mergeRepository: repository.fullName };
      let checked: PrepareCheckSandboxActivityOutput | null;
      try {
        checked = await withSandboxSlot(async (budgetMs) => {
          await buildSandboxActivities(budgetMs).selectSandboxProvider({
            runId: id,
            tenantId: input.tenantId,
            productId: input.productId,
            repositoryUrl: checkSpriteInput.primary.url,
            ...(setTargets === null ? {} : { targetRepositoryUrls: setTargets.slice(1).map((target) => target.url) }),
          });
          return await buildSandboxActivities(Math.max(1, Math.min(budgetMs, remainingMs()))).prepareBringCurrentSandbox(checkSpriteInput);
        });
      } catch (error) {
        if (isConfigurationFault(error)) {
          return endedWithoutOutcome(
            failRun("CONFIGURATION_INVALID", withCause(`Factoree could not prepare the check sandbox of the merge of ${update.baseBranch} into ${update.url}.`, error)),
          );
        }
        if (remainingMs() > 0) throw error;
        return endedWithoutOutcome(failRun("RUN_TIMEOUT", timeoutMessage));
      }
      if (checked === null) {
        if (stopRequested) return ended(await cancelRun(), { kind: "ended" });
        return endedWithoutOutcome(failRun("RUN_TIMEOUT", timeoutMessage));
      }
      checkSandbox = checked;
      const sprite = checked;
      if (stopRequested) return ended(await cancelRun(), { kind: "ended" });

      status = "VERIFYING";
      await activities.setRunStatus({ runId: id, status });
      let verification: VerifyActivityOutput;
      try {
        verification = await buildVerifyActivities(remainingMs()).verify({
          runId: id,
          tenantId: input.tenantId,
          productId: input.productId,
          spriteId: sprite.spriteId,
          adapter: sprite.adapter,
          workspacePath: sprite.workspacePath,
          primaryPath: sprite.primaryPath,
          commands: sprite.verifyCommands,
          timeoutMs: remainingMs(),
          attempt: 1,
          // DI-21.161. Each target of a set verifies with its own stack.
          ...(sprite.setCheck === undefined
            ? {}
            : { stacks: sprite.setCheck.targets.map((target) => ({ repository: target.repository, path: target.path, services: target.services })) }),
        });
      } catch (error) {
        if (remainingMs() > 0) throw error;
        return endedWithoutOutcome(failRun("RUN_TIMEOUT", timeoutMessage));
      }
      await notify(() => activities.postProgress({ sessionId: input.agentSessionId, message: verification.summary }));
      if (stopRequested) return ended(await cancelRun(), { kind: "ended" });
      if (!verification.passed) {
        return checkFailed(
          "VERIFICATION_FAILED",
          `Deterministic verification did not pass on the merge of ${update.baseBranch} into ${update.url}. ${verification.summary}`,
          [verification.summary, ...verification.failures].join("\n"),
        );
      }

      status = "USER_VALIDATING";
      await activities.setRunStatus({ runId: id, status });
      let replayed: UserValidateActivityOutput | null;
      try {
        replayed = await runUserValidate({ prepared: sprite, goal: adopted.goal, attempt: 1, replay: true });
      } catch (error) {
        if (isCancellation(error)) throw error;
        if (isConfigurationFault(error)) {
          return endedWithoutOutcome(failRun("CONFIGURATION_INVALID", withCause("Factoree could not replay the Validation Plan on the merge.", error)));
        }
        if (remainingMs() > 0) throw error;
        return endedWithoutOutcome(failRun("RUN_TIMEOUT", timeoutMessage));
      }
      if (stopRequested) return ended(await cancelRun(), { kind: "ended" });
      if (replayed === null) {
        if (remainingMs() === 0) return endedWithoutOutcome(failRun("RUN_TIMEOUT", timeoutMessage));
        throw ApplicationFailure.nonRetryable("the userValidate activity returned no result");
      }
      if (!replayed.passed) {
        return checkFailed(
          "VALIDATION_FAILED",
          `The replay of the frozen Validation Contract did not pass on the merge of ${update.baseBranch} into ${update.url}. ${replayed.summary}`,
          [replayed.summary, ...replayed.failures].join("\n"),
        );
      }

      status = "PUBLISHING";
      await activities.setRunStatus({ runId: id, status });
      if (stopRequested) return ended(await cancelRun(), { kind: "ended" });
      let pushed: PushBringCurrentMergeActivityOutput;
      try {
        // DI-21.161. The check sprite of a set proved the merge patch of its target, and names the set by
        // the set patch hash.
        pushed = await bringCurrentActivities.pushBringCurrentMerge({
          ...mergeInput,
          baseSha: merged.baseSha,
          verifiedPatchSha256: setTargets === null ? sprite.patchSha256 : merged.patchSha256,
        });
      } catch (error) {
        if (isCancellation(error)) throw error;
        if (isConfigurationFault(error)) {
          return endedWithoutOutcome(failRun("CONFIGURATION_INVALID", withCause(`Factoree could not push the merge commit to ${update.url}.`, error)));
        }
        return endedWithoutOutcome(failRun(publicationFailureReasonOf(error), withCause(`Factoree could not push the merge commit to ${update.url}.`, error)));
      }
      if (pushed.kind === "moved") {
        return ended(
          await endReported(`The branch of ${update.url} moved while Factoree checked the merge, so Factoree pushed nothing. The new head gets its own checks.`),
          { kind: "moved" },
        );
      }
      publishedPullRequestUrls.push(update.url);
      await activities.recordRunTargetFacts({
        tenantId: input.tenantId,
        runId: id,
        repositoryId: repository.id,
        baseSha: merged.baseSha,
        patchSha256: pushed.patchSha256,
        commitSha: pushed.commitSha,
        pullRequestUrl: update.url,
      });
      // DI-21.104, D2. The merge commit is the verified head, and the new base is its base. The level
      // and the contract revision of the head stay, because the contract did not change.
      await activities.recordPullRequest({
        tenantId: input.tenantId,
        runId: id,
        repositoryId: repository.id,
        number: update.number,
        url: update.url,
        headBranch: update.headBranch,
        headSha: pushed.commitSha,
        baseBranch: update.baseBranch,
        autonomyLevel: update.autonomyLevel,
        baseSha: merged.baseSha,
        contractRevision: update.contractRevision,
      });
      // docs/specs/change-sets.md, slice 9. The merge commit is a head Factoree pushed after a set check,
      // so each consumer status of the set is set again from it.
      if (setMembers !== null) {
        await notify(async () => {
          await activities.setChangeSetStatuses({ tenantId: input.tenantId, pullRequestId: update.pullRequestId });
        });
      }
      return ended(
        await endReported(
          [
            "## Bring current",
            "",
            `Factoree merged ${update.baseBranch} at ${merged.baseSha.slice(0, 12)} into ${update.url} and pushed the merge commit ` +
              `${pushed.commitSha.slice(0, 12)}. It did not force-push.`,
            "",
            `- Verified patch: ${pushed.patchSha256}, the diff from the new base to the merge.`,
            `- Verification: ${verification.summary}`,
            `- Validation Contract ${adopted.sha256.slice(0, 12)} (contract revision ${String(update.contractRevision)}), replayed with no agent: ${replayed.summary}`,
          ].join("\n"),
        ),
        { kind: "pushed", commitSha: pushed.commitSha, baseSha: merged.baseSha },
      );
    }

    // docs/specs/pr-review-merge-and-deploy.md, DI-21.110. A failed PR reviewer check: a fresh reviewer
    // session in a check sprite of the pull request head keeps only the findings with a concrete
    // defect, a rule and evidence. Factoree replies on the pull request to each dropped finding. A
    // triage that keeps nothing ends the run with no change, and it does not count toward the limit.
    if (prFollowUp !== null && prFollowUp.trigger === "reviewer") {
      if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
      const stoppedInQueue = await waitForRunSlot();
      if (stoppedInQueue !== null) return stoppedInQueue;
      status = "REVIEWING";
      await activities.setRunStatus({ runId: id, status });
      const repository = targetRepositories.find((candidate) => candidate.id === prFollowUp.repositoryId);
      if (repository === undefined) {
        return await failRun(
          "TARGET_UNRESOLVED",
          `The repository ${prFollowUp.repositoryFullName} of ${prFollowUp.url} is no longer part of this product, so Factoree cannot triage its review.`,
        );
      }
      const triageInput = {
        runId: id,
        tenantId: input.tenantId,
        productId: input.productId,
        primary: { url: buildRepositoryUrl(input.product.repositoryBaseUrl, repository.fullName), ref: prFollowUp.baseSha },
        references: [],
        defaults: {
          stagingRead: input.product.stagingRead,
          spriteRetentionHours: input.product.spriteRetentionHours,
          allowedDomains: input.product.allowedDomains,
        },
        environment: {},
        organizationSkills: null,
        githubInstallationId: repository.githubInstallationId,
        skillRegistry: null,
        pullRequestHead: prFollowUp.headSha,
      };
      let triageSprite: PrepareSandboxActivityOutput | null;
      try {
        triageSprite = await withSandboxSlot(async (budgetMs) => {
          await buildSandboxActivities(budgetMs).selectSandboxProvider({
            runId: id,
            tenantId: input.tenantId,
            productId: input.productId,
            repositoryUrl: triageInput.primary.url,
          });
          return await buildSandboxActivities(Math.max(1, Math.min(budgetMs, remainingMs()))).prepareTriageSandbox(triageInput);
        });
      } catch (error) {
        if (isConfigurationFault(error)) {
          return await failRun(
            "CONFIGURATION_INVALID",
            withCause(`Factoree could not prepare the check sandbox of the pull request head of ${prFollowUp.url}.`, error),
          );
        }
        if (remainingMs() > 0) throw error;
        return await failRun("RUN_TIMEOUT", timeoutMessage);
      }
      if (triageSprite === null) {
        if (stopRequested) return await cancelRun();
        return await failRun("RUN_TIMEOUT", timeoutMessage);
      }
      const sprite = triageSprite;
      const reviewerName = prFollowUp.reviewer === null ? "PR reviewer" : `${prFollowUp.reviewer.appSlug} (${prFollowUp.reviewer.checkName})`;
      const triageOnce = (afterHang: boolean, unreachableRetry = 0): Promise<TriageActivityOutput | null> =>
        runAgentActivity(() =>
          buildReviewActivities(remainingMs()).triagePullRequestFindings({
            runId: id,
            tenantId: input.tenantId,
            productId: input.productId,
            runnerName: sprite.runtime.reviewerRunner,
            spriteId: sprite.spriteId,
            adapter: sprite.adapter,
            workspacePath: sprite.workspacePath,
            primaryPath: sprite.primaryPath,
            baseSha: sprite.baseSha,
            pullRequestUrl: prFollowUp.url,
            reviewerName,
            findings: prFollowUp.findings,
            repositoryInstructions: sprite.repositoryInstructions,
            timeoutMs: remainingMs(),
            ...(afterHang ? { afterHang: true } : {}),
            ...(unreachableRetry > 0 ? { unreachableRetry } : {}),
          }),
        );
      let triage: TriageActivityOutput | null;
      try {
        triage = await triageOnce(false);
        triage = await retryWhileUnreachable("reviewer", triage, (retry) => triageOnce(false, retry));
        // docs/specs/agent-session-usage-and-hangs.md. A hung session gets one fresh session.
        const hang = hangOf(triage);
        if (triage !== null && hang !== null && !stopRequested && remainingMs() > 0) {
          await reportHang("reviewer", hang, "starts one fresh session");
          triage = await triageOnce(true);
          triage = await retryWhileUnreachable("reviewer", triage, (retry) => triageOnce(true, retry), PROVIDER_UNREACHABLE_ATTEMPTS - 1);
        }
      } catch (error) {
        if (isCancellation(error)) throw error;
        if (isConfigurationFault(error)) {
          return await failRun(
            "CONFIGURATION_INVALID",
            withCause("Factoree could not start the triage session. Repair the reviewer runner on the product page.", error),
          );
        }
        if (remainingMs() > 0) throw error;
        return await failRun("RUN_TIMEOUT", timeoutMessage);
      } finally {
        // The triage sprite serves the triage only. A failed delete is logged by the activity.
        await CancellationScope.nonCancellable(() =>
          notify(() =>
            cancelActivities.releaseCheckSandbox({ runId: id, spriteId: sprite.spriteId, adapter: sprite.adapter, workspacePath: sprite.workspacePath }),
          ),
        );
      }
      if (stopRequested) return await cancelRun();
      if (triage === null) {
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
        return await failRun("REVIEW_UNAVAILABLE", `The triage of the PR reviewer findings on ${prFollowUp.url} did not finish.`);
      }
      const triageUnreachable = providerUnreachableOf(triage);
      if (triageUnreachable !== null) return await failProviderUnreachable("reviewer", triageUnreachable);
      const triageHang = hangOf(triage);
      if (triageHang !== null) return await failHung("reviewer", triageHang);
      if (!triage.reportUsable) {
        return await failRun(
          "REVIEW_UNAVAILABLE",
          `Factoree could not triage the PR reviewer findings on ${prFollowUp.url}. ${triage.reportProblem ?? ""}`.trim(),
        );
      }
      triagedFindings = triage.decisions;
      const kept = triage.decisions.filter((decision) => decision.kept);
      const dropped = triage.decisions.filter((decision) => !decision.kept);
      if (dropped.length > 0) {
        await notify(async () => {
          await pullRequestReplyActivities.answerDroppedFindings({
            tenantId: input.tenantId,
            pullRequestId: prFollowUp.pullRequestId,
            findings: prFollowUp.findings,
            dropped,
          });
        });
      }
      const triageLine =
        `Factoree triaged ${String(triage.decisions.length)} ${triage.decisions.length === 1 ? "finding" : "findings"} of the PR reviewer on ${prFollowUp.url}: ` +
        `it kept ${String(kept.length)} and dropped ${String(dropped.length)}.` +
        (dropped.length === 0 ? "" : " It replied on the pull request to each dropped finding with the reason.");
      if (kept.length === 0) {
        return await endReported(
          [
            "## Factoree triage",
            "",
            triageLine,
            "",
            "No finding names a concrete defect, a rule and evidence, so Factoree changed nothing. This triage does not count toward the limit of PR follow-up runs.",
          ].join("\n"),
        );
      }
      await notify(() => activities.postProgress({ sessionId: input.agentSessionId, message: triageLine }));
      await activities.countReviewerFollowUp({ tenantId: input.tenantId, pullRequestId: prFollowUp.pullRequestId, runId: id });
      workItemDescription = renderPrFollowUpDescription({ description: input.workItem.description, followUp: prFollowUp, kept });
      initialRepairFindings = keptFindingLines(kept);
    }

    {
      // A Run whose budget has already passed must not start work it cannot finish.
      if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

      // SDD section 28. The webhook carries no label, so the labels come from the Linear API
      // before Refinement classifies the risk of this Work Item. A read that never recovers,
      // after the activity's own retry policy is exhausted, must not fail the Run. The risk cap is
      // a security control, so it fails closed: the Run then runs at L2 at most.
      // docs/specs/autonomy-levels.md. A cancellation is not a label-read fault, so it still
      // propagates.
      let labels = input.workItem.labels;
      let labelsUnreadable = false;
      // docs/specs/own-proposals-and-parallel-runs.md. The Linear project can choose the target.
      let linearProject: string | null = null;
      const issueId = input.workItem.issueId;
      if (issueId !== null) {
        try {
          const facts = await activities.fetchWorkItemFacts({ sessionId: input.agentSessionId, issueId });
          labels = facts.labels;
          linearProject = facts.project;
        } catch (error) {
          if (isCancellation(error)) throw error;
          // The webhook labels are never worse than an empty list, so the fallback keeps them.
          labels = input.workItem.labels;
          labelsUnreadable = true;
          // The cap of SDD section 28 is a security control, so a degraded cap must be visible.
          // A Linear fault must not fail the Run either, so the post stays inside `notify`.
          await notify(() =>
            activities.postProgress({
              sessionId: input.agentSessionId,
              message:
                "Factoree could not read the labels of this Work Item, so it runs this Run at L2 " +
                "at most and opens a draft pull request.",
            }),
          );
        }
      }

      // docs/specs/work-item-images-and-links.md. The human comments, the images and the links of
      // the issue, read once at the start. A reply "ignore the images" freezes as a decision.
      let workItemContent: ReadWorkItemContentActivityOutput | null = null;
      if (input.ignoreImages === true) {
        decisions.push({ ...IGNORE_IMAGES_DECISION, answer: "Ignore the images. A human chose to run without the image check." });
      }
      if (issueId !== null && patched(WORK_ITEM_CONTENT_PATCH)) {
        try {
          workItemContent = await workItemActivities.readWorkItemContent({
            tenantId: input.tenantId,
            productId: input.productId,
            runId: id,
            issueId,
            description: workItemDescription,
            delegatedAt: input.delegatedAt ?? null,
            repositories: targetRepositories.map((repository) => ({
              fullName: repository.fullName,
              githubInstallationId: repository.githubInstallationId,
            })),
          });
        } catch (error) {
          if (isCancellation(error)) throw error;
          // DI-21.45. A Linear fault must not fail the Run, and the human must see what it lost.
          await notify(() =>
            activities.postProgress({
              sessionId: input.agentSessionId,
              message:
                "Factoree could not read the comments, the images and the links of this issue, so this Run " +
                "uses the description only.",
            }),
          );
        }
        // Before preparation: a role model that cannot read an image ends the Run, unless the
        // human replied "ignore the images".
        if (workItemContent !== null && workItemContent.visionFailure !== null && input.ignoreImages !== true) {
          return await failRun("CONFIGURATION_INVALID", workItemContent.visionFailure);
        }
      }

      // SDD section 8. Refinement reads the Work Item and the Project record only. It reaches no
      // repository and no sandbox, so it runs before preparation.
      const refinementInput = () => ({
        runId: id,
        tenantId: input.tenantId,
        productId: input.productId,
        source: { ...input.workItem, description: workItemDescription, labels },
        project: {
          primaryRepository: primaryRepositorySlug,
          referenceRepositories: referenceRepositorySlugs,
          defaultAutonomy: input.product.defaultAutonomy,
          riskCaps: input.product.riskCaps,
        },
        labelsUnreadable,
        decisions,
      });

      status = "REFINING";
      await activities.setRunStatus({ runId: id, status });
      let refined = await refineActivities.refine(refinementInput());

      // SDD section 8. A material product question blocks the Run. The rounds are bounded, so
      // this loop always ends.
      while (refined.status === "needs_input") {
        const question = refined.unresolvedQuestions[0];
        // A `needs_input` result with no question names nothing a human can answer. The Run must
        // not continue as if refinement were ready.
        if (question === undefined) {
          return await failRun(
            "REFINEMENT_UNRESOLVED",
            "Refinement needs input but named no question, so Factoree cannot continue.",
          );
        }
        const proceeded = await askAndWait(question.id, question.question);
        if (stopRequested) return await cancelRun();
        if (!proceeded) {
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          return await failRun(
            "REFINEMENT_UNRESOLVED",
            "Factoree could not start, because a material product decision is still open: " +
              `${question.question} Factoree must not invent product behavior, ` +
              "so it published nothing.",
          );
        }
        status = "REFINING";
        await activities.setRunStatus({ runId: id, status });
        refined = await refineActivities.refine(refinementInput());
      }

      // SDD section 28. Refinement caps the autonomy level of the Run. The Run row was created
      // before Refinement ran, so it still holds the raw Project default. The capped level is
      // the level that governs the Run, so it reaches the row here.
      await activities.setRunAutonomyLevel({
        tenantId: input.tenantId,
        runId: id,
        autonomyLevel: refined.autonomyLevel,
      });

      // SDD section 8. Refinement reports a risk that a human must see. Factoree does not block
      // the Run on one, so the report is the only place a human learns of it. An empty list
      // produces no message.
      const riskMessage = renderRisks(refined.risks);
      if (riskMessage !== null) {
        await notify(() =>
          activities.postProgress({ sessionId: input.agentSessionId, message: riskMessage }),
        );
      }

      // Specification section 10. Target selection decides the repository this Run changes.
      // A constant epoch fills the fields `selectTarget` does not read. This keeps the mapping
      // deterministic.
      const EPOCH = new Date(0);
      const presentRepositories: RepositoryRecord[] = targetRepositories.map((repository) => ({
        id: repository.id,
        tenantId: input.tenantId,
        productId: input.product.productId,
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch,
        configSha: "",
        requestedSecretNames: [],
        linearProjects: repository.linearProjects,
        discoveredAt: EPOCH,
        lastSeenAt: EPOCH,
        absentSince: repository.absentSince === null ? null : new Date(repository.absentSince),
        githubInstallationId: repository.githubInstallationId,
      }));

      /**
       * Applies a confirmed target. It corrects the repository fields Refinement echoed. It
       * records the RunTarget row. It posts the notice when `notice` is true.
       */
      const applyTarget = async (
        repository: RepositoryRecord,
        reason: string,
        notice: boolean,
      ): Promise<void> => {
        primaryRepositorySlug = repository.fullName;
        primaryRepositoryId = repository.id;
        primaryRepositoryInstallationId = repository.githubInstallationId;
        refined.primaryRepository = repository.fullName;
        // Specification section 12. A sibling repository is absent at start. An agent that
        // needs one calls clone_sibling, which the Action Policy gates. Target selection must
        // not populate reference repositories from Product membership, because that would
        // bypass the gate and check out every sibling unconditionally.
        await activities.recordRunTarget({
          tenantId: input.tenantId,
          runId: id,
          repositoryId: repository.id,
          selectionReason: reason,
        });
        if (notice) await takeDecision({ kind: "target", statement: `chose ${repository.fullName}`, reason });
      };

      /**
       * docs/specs/change-sets.md. Applies a confirmed set: one RunTarget row per target, in set
       * order. The first target is the primary repository. One notice names the whole set.
       */
      const applyTargets = async (repositories: RepositoryRecord[], reason: string, notice: boolean): Promise<void> => {
        const first = repositories[0];
        if (first === undefined) return;
        primaryRepositorySlug = first.fullName;
        primaryRepositoryId = first.id;
        primaryRepositoryInstallationId = first.githubInstallationId;
        refined.primaryRepository = first.fullName;
        runTargets = repositories;
        for (const repository of repositories) {
          await activities.recordRunTarget({ tenantId: input.tenantId, runId: id, repositoryId: repository.id, selectionReason: reason });
        }
        if (notice) {
          const names = repositories.map((repository) => repository.fullName);
          const statement = names.length === 1 ? `chose ${names[0] ?? ""}` : `chose ${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
          await takeDecision({ kind: "target", statement, reason });
        }
      };

      // docs/specs/own-proposals-and-parallel-runs.md. The issue text or the Linear project decides
      // the target when exactly one repository matches. A pick among equals is a guess, so only
      // then does a human choose.
      // docs/specs/pr-review-merge-and-deploy.md. A PR follow-up run changes the repository of its
      // pull request, and no other.
      const pullRequestRepository =
        prFollowUp === null ? null : (presentRepositories.find((repository) => repository.id === prFollowUp.repositoryId) ?? null);
      if (prFollowUp !== null && pullRequestRepository === null) {
        return await failRun(
          "TARGET_UNRESOLVED",
          `The repository ${prFollowUp.repositoryFullName} of ${prFollowUp.url} is no longer part of this product, so Factoree cannot change it.`,
        );
      }
      // docs/specs/change-sets.md. A run changes a set of repositories. The patch keeps the one-target
      // selection of a history that passed this point before sets existed.
      if (!patched(CHANGE_SET_PATCH)) {
        let targetOutcome: ReturnType<typeof selectTarget> =
          pullRequestRepository !== null
            ? { kind: "selected", repository: pullRequestRepository, reason: `the repository of ${prFollowUp?.url ?? "the pull request"}`, notify: false }
            : selectTarget(
                presentRepositories,
                proposeTarget(presentRepositories, `${input.workItem.title}\n\n${input.workItem.description}`, linearProject),
              );
        while (targetOutcome.kind === "ambiguous") {
          const candidateNames = targetOutcome.candidates.map((candidate) => candidate.fullName).join(", ");
          const proceeded = await askAndWait(
            "target-selection",
            "Factoree found several repositories in this Product, and no confident target. " +
              `Candidates: ${candidateNames}. Reply with the exact repository name to use.`,
            undefined,
            undefined,
            "BLOCKED_TARGET",
          );
          if (stopRequested) return await cancelRun();
          if (!proceeded) {
            if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
            return await failRun(
              "TARGET_UNRESOLVED",
              "Factoree could not confirm the target repository of this Product, so it published " +
                "nothing.",
            );
          }
          const reply = decisions[decisions.length - 1]?.answer ?? "";
          const chosen = matchReplyToCandidate(reply, targetOutcome.candidates);
          targetOutcome =
            chosen === null
              ? { kind: "ambiguous", candidates: targetOutcome.candidates }
              : { kind: "selected", repository: chosen, reason: "human reply", notify: false };
        }
        await applyTarget(targetOutcome.repository, targetOutcome.reason, targetOutcome.notify);
        runTargets = [targetOutcome.repository];
      } else {
        // DI-21.131. A follow-up run changes the set of the run it follows. A repository that left
        // the product since then cannot be changed, and a guess would re-route the work.
        const followUpTargets = prFollowUp === null ? (input.followUpTargets ?? []) : [];
        const followUpSet = followUpTargets.map((repositoryId) => presentRepositories.find((repository) => repository.id === repositoryId) ?? null);
        const goneTarget = followUpSet.findIndex((repository) => repository === null || repository.absentSince !== null);
        if (goneTarget >= 0) {
          const gone = followUpSet[goneTarget];
          return await failRun(
            "TARGET_UNRESOLVED",
            `The repository ${gone?.fullName ?? followUpTargets[goneTarget] ?? ""} of the run this run follows is no longer part of this product, so Factoree cannot change it.`,
          );
        }
        // docs/specs/change-sets.md, slice 9, DI-21.159. A set PR follow-up run changes every pull request
        // of the set that is open, and holds each merged one fixed at its merge.
        const setRepositories = prChangeSet === null ? null : prChangeSet.members.map((member) => presentRepositories.find((repository) => repository.id === member.repositoryId) ?? null);
        const goneMember = setRepositories === null ? -1 : setRepositories.findIndex((repository) => repository === null || repository.absentSince !== null);
        if (goneMember >= 0) {
          const member = prChangeSet?.members[goneMember];
          return await failRun(
            "TARGET_UNRESOLVED",
            `The repository ${member?.repositoryFullName ?? ""} of ${member?.url ?? "the change set"} is no longer part of this product, so Factoree cannot change the change set.`,
          );
        }
        let setOutcome: TargetSetOutcome =
          setRepositories !== null
            ? {
                kind: "selected",
                repositories: inSetOrder(setRepositories.filter((repository): repository is RepositoryRecord => repository !== null)),
                reason: `the pull requests of the change set of ${prFollowUp?.url ?? "the pull request"}`,
                notify: false,
              }
            : pullRequestRepository !== null
            ? { kind: "selected", repositories: [pullRequestRepository], reason: `the repository of ${prFollowUp?.url ?? "the pull request"}`, notify: false }
            : followUpSet.length > 0
              ? {
                  kind: "selected",
                  repositories: inSetOrder(followUpSet.filter((repository): repository is RepositoryRecord => repository !== null)),
                  reason: "the targets of the run this run follows",
                  notify: false,
                }
              : selectTargets(
                  presentRepositories,
                  proposeTargets(presentRepositories, `${input.workItem.title}\n\n${input.workItem.description}`, linearProject),
                );
        while (setOutcome.kind === "ambiguous") {
          const candidateNames = setOutcome.candidates.map((candidate) => candidate.fullName).join(", ");
          const proceeded = await askAndWait(
            "target-selection",
            "Factoree found several repositories in this Product, and no rule decides which ones this issue changes. " +
              `Candidates: ${candidateNames}. Reply with the exact name of each repository to change.`,
            undefined,
            undefined,
            "BLOCKED_TARGET",
          );
          if (stopRequested) return await cancelRun();
          if (!proceeded) {
            if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
            return await failRun(
              "TARGET_UNRESOLVED",
              "Factoree could not confirm the target repositories of this Product, so it published " +
                "nothing.",
            );
          }
          const chosen = matchReplyToCandidates(decisions[decisions.length - 1]?.answer ?? "", setOutcome.candidates);
          setOutcome =
            chosen.length === 0
              ? { kind: "ambiguous", candidates: setOutcome.candidates }
              : { kind: "selected", repositories: chosen, reason: "human reply", notify: false };
        }
        await applyTargets(setOutcome.repositories, setOutcome.reason, setOutcome.notify);
      }

      // SDD section 20. Discovery pins one SHA for each repository. The ref below is the ref
      // discovery starts from. The checkout later uses the pinned SHA.
      const repositoryRef = (slug: string) => ({
        slug,
        url: buildRepositoryUrl(input.product.repositoryBaseUrl, slug),
        ref: defaultBranchForSlug(slug),
      });

      // SDD section 23. A conflict without an authority winner blocks the Run. The bounded
      // rounds end this loop, and the Run budget ends it as well.
      // docs/specs/change-sets.md, DI-21.143. A target the refiner adds resolves the context again
      // for the whole set, with `supersedes`, so the run's contract lists every target.
      type ContextScope = {
        primaryRepository: { slug: string; url: string; ref: string };
        referenceRepositories: Array<{ slug: string; url: string; ref: string }>;
        targetRepositories: Array<{ slug: string; url: string; ref: string; githubInstallationId: string }>;
        supersedes?: string;
      };
      const resolveContextLoop = async (
        scope: ContextScope,
      ): Promise<{ resolved: ResolveContextActivityOutput } | { ended: AgentRunWorkflowResult }> => {
        for (;;) {
          if (remainingMs() === 0) return { ended: await failRun("RUN_TIMEOUT", timeoutMessage) };

          status = "RESOLVING_CONTEXT";
          await activities.setRunStatus({ runId: id, status });

          let resolution: ResolveContextActivityOutput;
          try {
            resolution = await buildContextActivities(remainingMs()).resolveContext({
              runId: id,
              tenantId: input.tenantId,
              productId: input.productId,
              goal: refined.goal,
              acceptanceCriteria: refined.acceptanceCriteria,
              primaryRepository: scope.primaryRepository,
              referenceRepositories: scope.referenceRepositories,
              // docs/specs/change-sets.md. The other targets of a change set, each at its default branch.
              ...(scope.targetRepositories.length > 0 ? { targetRepositories: scope.targetRepositories } : {}),
              ...(scope.supersedes === undefined ? {} : { supersedes: scope.supersedes }),
              workItemReferences: refined.workItemReferences,
              decisions,
              githubInstallationId: primaryRepositoryInstallationId,
              // docs/specs/work-item-images-and-links.md. An activity input adds no workflow command.
              ...(workItemContent === null
                ? {}
                : {
                    workItemContent: {
                      comments: workItemContent.comments,
                      images: workItemContent.images,
                      links: workItemContent.links,
                      skippedImages: workItemContent.skippedImages,
                      linksNotRead: workItemContent.linksNotRead,
                    },
                  }),
            });
          } catch (error) {
            // SDD section 49. A repository reference that resolves to nothing is a semantic
            // failure, so it drives a workflow decision. The retry policy already denied a second
            // attempt. A transport fault is not this type, so it still retries.
            if (isConfigurationFault(error)) {
              return {
                ended: await failRun(
                  "CONFIGURATION_INVALID",
                  withCause(
                    "Factoree could not resolve the context, because the Run configuration is invalid. " +
                      "Repair the repository reference, the reference repositories, or the default branch.",
                    error,
                  ),
                ),
              };
            }
            throw error;
          }
          // SDD section 21. Only a frozen Context Contract has a version. A resolution that still
          // holds an unresolved conflict stored nothing, so the snapshot reports no version.
          contextContractVersion =
            resolution.unresolvedConflict === null ? resolution.sha256 : null;

          await notify(() =>
            activities.postProgress({
              sessionId: input.agentSessionId,
              message: resolution.summary,
            }),
          );

          const conflict = resolution.unresolvedConflict;
          if (conflict === null) return { resolved: resolution };

          // SDD section 23. No safe resolution exists, so implementation must not start.
          const proceeded = await askAndWait(
            conflict.id,
            conflict.question,
            conflict.subject,
            conflict.domain,
          );
          if (stopRequested) return { ended: await cancelRun() };
          if (!proceeded) {
            if (remainingMs() === 0) return { ended: await failRun("RUN_TIMEOUT", timeoutMessage) };
            return {
              ended: await failRun(
                "CONTEXT_UNRESOLVED",
                "Factoree could not start, because two equally authoritative sources disagree: " +
                  `${conflict.question} Factoree published nothing.`,
              ),
            };
          }
        }
      };
      const firstContext = await resolveContextLoop({
        // D2. A PR follow-up run reads its context at the verified base of the pull request.
        // DI-21.159. Each member of a set PR follow-up run reads its context at its own base.
        primaryRepository:
          prFollowUp === null
            ? repositoryRef(refined.primaryRepository)
            : { ...repositoryRef(refined.primaryRepository), ref: setMemberOf(refined.primaryRepository)?.baseSha ?? prFollowUp.baseSha },
        referenceRepositories: refined.referenceRepositories.map(repositoryRef),
        targetRepositories:
          runTargets.length > 1
            ? runTargets.slice(1).map((target) => {
                const member = setMemberOf(target.fullName);
                return { ...repositoryRef(target.fullName), ...(member === null ? {} : { ref: member.baseSha }), githubInstallationId: target.githubInstallationId };
              })
            : [],
      });
      if ("ended" in firstContext) return firstContext.ended;
      let resolvedContext: ResolveContextActivityOutput = firstContext.resolved;

      // A stop that arrived during the context work must prevent preparation.
      if (stopRequested) return await cancelRun();
      if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

      // Specification section 8. The routing table used a cached repository row. The base
      // commit is the ground truth. Factoree reads the identity block there. It checks that
      // block against the Product routing used.
      // docs/specs/change-sets.md. Each target of a change set is checked at its own base, in set order.
      // A run with one target makes the one call it made before.
      const targetBases = (runTargets.length === 0 ? [{ id: primaryRepositoryId, fullName: resolvedContext.primary.slug, githubInstallationId: primaryRepositoryInstallationId }] : runTargets).map(
        (target, index) => ({
          ...target,
          slug: index === 0 ? resolvedContext.primary.slug : target.fullName,
          sha: index === 0 ? resolvedContext.primary.sha : (resolvedContext.targets?.find((pinned) => pinned.slug === target.fullName)?.sha ?? ""),
        }),
      );
      for (const target of targetBases) {
        const identity = await activities.verifyTargetIdentity({
          runId: id,
          tenantId: input.tenantId,
          productId: input.productId,
          productSlug: input.product.productSlug,
          repositoryUrl: buildRepositoryUrl(input.product.repositoryBaseUrl, target.slug),
          baseSha: target.sha,
          githubInstallationId: target.githubInstallationId,
        });
        if (stopRequested) return await cancelRun();
        if (!identity.matched) {
          return await endRoutingMismatch(
            input.product.productSlug,
            identity.declaredProduct ?? "an unknown Product",
          );
        }
      }

      // Specification section 14. The base SHA of each target's RunTarget row is known now, at
      // context resolution.
      for (const target of targetBases) {
        await activities.recordRunTargetFacts({
          tenantId: input.tenantId,
          runId: id,
          repositoryId: target.id,
          baseSha: target.sha,
        });
      }

      // docs/specs/autonomy-levels.md. L0 reads and reports. The Context Contract is the report,
      // and no sandbox starts.
      if (refined.autonomyLevel === "L0") {
        return await endReported(
          [
            "## Factoree report",
            "",
            `Status: REPORTED at L0. ${autonomyNote(refined.autonomyReasons)}`,
            "",
            "### Context",
            "",
            resolvedContext.summary,
            "",
            "### Risks",
            "",
            refined.risks.length === 0 ? "None." : refined.risks.map((risk) => `- ${risk}`).join("\n"),
            "",
            "Factoree changed nothing and opened no pull request.",
          ].join("\n"),
        );
      }

      // SDD section 15. The runtime configuration comes from `.factoree/config.yaml` in the
      // primary repository. Only the values a repository must not own travel from here.
      const sandbox = {
        primary: {
          url: buildRepositoryUrl(input.product.repositoryBaseUrl, resolvedContext.primary.slug),
          // SDD section 20. The checkout lands on the SHA discovery pinned. A branch name can
          // point to a new commit at any time, so the workflow must not use one here. The Run
          // and the Context Contract then read one state of the repository.
          ref: resolvedContext.primary.sha,
        },
        references: resolvedContext.references.map((repository) => ({
          url: buildRepositoryUrl(input.product.repositoryBaseUrl, repository.slug),
          ref: repository.sha,
        })),
        defaults: {
          stagingRead: input.product.stagingRead,
          spriteRetentionHours: input.product.spriteRetentionHours,
          allowedDomains: input.product.allowedDomains,
        },
        organizationSkills:
          input.product.organizationSkillsRepository === null
            ? null
            : {
                url: buildRepositoryUrl(
                  input.product.repositoryBaseUrl,
                  input.product.organizationSkillsRepository,
                ),
                // No discovery step resolves a skills repository, so the target repository default
                // branch is the only defined ref. See DI-11.3.
                ref: defaultBranchForSlug(primaryRepositorySlug),
              },
        goal: refined.goal,
      };

      // docs/specs/release-0-1-0.md, DI-15.13. A Run over its Product's maxConcurrentRuns waits
      // in QUEUED here, before any sandbox or agent session costs anything.
      const stoppedInQueue = await waitForRunSlot();
      if (stoppedInQueue !== null) return stoppedInQueue;

      status = "PREPARING";
      await activities.setRunStatus({ runId: id, status });

      // The work sprite and every check sprite are prepared from the same input.
      // docs/specs/change-sets.md, DI-21.140. A target the refiner adds joins it.
      let prepareInput = {
        runId: id,
        tenantId: input.tenantId,
        productId: input.productId,
        primary: sandbox.primary,
        // docs/specs/change-sets.md. Each target of a change set at its base, with its installation.
        ...(targetBases.length > 1
          ? {
              targets: targetBases.map((target) => ({
                repository: target.slug,
                url: buildRepositoryUrl(input.product.repositoryBaseUrl, target.slug),
                ref: target.sha,
                githubInstallationId: target.githubInstallationId,
              })),
            }
          : {}),
        references: sandbox.references,
        defaults: sandbox.defaults,
        environment: {},
        organizationSkills: sandbox.organizationSkills,
        githubInstallationId: primaryRepositoryInstallationId,
        skillRegistry: input.product.skillRegistry ?? null,
        // docs/specs/external-context-delivery.md. The work sprite delivery fetches the external
        // context items in contract order. An activity input adds no workflow command.
        ...(resolvedContext.deliveryRefs === undefined ? {} : { contextRefs: resolvedContext.deliveryRefs }),
        // docs/specs/work-item-images-and-links.md. The work sprite and every check sprite receive
        // the frozen images. The comments and the links go to the work sprite.
        ...(workItemContent === null
          ? {}
          : {
              workItemImages: workItemContent.images,
              workItemComments: workItemContent.comments,
              workItemLinks: workItemContent.links,
            }),
      };

      // D2. The work sprite of a PR follow-up run holds the full change of the pull request: the
      // verified base, with the diff to the head the run read. A check sprite takes the captured patch.
      // Slice 4, DI-21.119. A base update merges the head into the new base, conflict markers and all.
      // docs/specs/change-sets.md, slice 9, DI-21.159. A set PR follow-up run applies each open pull
      // request of the set to its own target, and leaves each merged one at its merge commit.
      // The overlays apply to whatever the prepare input holds now, so a rebuilt sandbox keeps them.
      const workInputOf = (base: typeof prepareInput): typeof prepareInput & { pullRequestHead?: string; pullRequestMerge?: boolean } => {
        const setWorkTargets =
          prChangeSet === null || prFollowUp === null || base.targets === undefined
            ? null
            : base.targets.map((target) => {
                const member = setMemberOf(target.repository);
                if (member === null || member.state !== "open") return target;
                const merges = prFollowUp.baseUpdate !== undefined && member.pullRequestId === prFollowUp.pullRequestId;
                return { ...target, pullRequestHead: member.headSha, ...(merges ? { pullRequestMerge: true } : {}) };
              });
        return prFollowUp === null
          ? base
          : setWorkTargets !== null
            ? { ...base, targets: setWorkTargets }
            : { ...base, pullRequestHead: prFollowUp.headSha, ...(prFollowUp.baseUpdate === undefined ? {} : { pullRequestMerge: true }) };
      };
      const workInput = workInputOf(prepareInput);

      // docs/specs/change-sets.md, DI-21.138. The refiner of a run that can add a target reads the
      // other present repositories of the product. A PR follow-up run and a bring-current run keep
      // their target, so they read none.
      const refinerTargetsOpen = prFollowUp === null && bringCurrent === null;
      const siblingRepositories = refinerTargetsOpen
        ? targetRepositories.filter(
            (repository) =>
              repository.absentSince === null &&
              !targetBases.some((target) => target.slug.toLowerCase() === repository.fullName.toLowerCase()),
          )
        : [];
      const firstWorkInput =
        siblingRepositories.length === 0
          ? workInput
          : { ...workInput, siblings: { repositoryBaseUrl: input.product.repositoryBaseUrl, repositories: siblingRepositories } };

      // SDD section 32. The sandbox stays after the Run ends. `SpriteReaper` deletes it once the
      // retention window of SDD section 51 has passed.
      // docs/specs/change-sets.md, DI-21.140. A target the refiner adds prepares the work sprite again.
      const prepareWorkSprite = async (
        workSpriteInput: typeof firstWorkInput,
      ): Promise<{ prepared: PrepareSandboxActivityOutput } | { ended: AgentRunWorkflowResult }> => {
        try {
          const work = await withSandboxSlot(async (budgetMs) => {
            if (!patched(SANDBOX_PROVIDER_PATCH)) return buildSandboxActivities(budgetMs).prepareSandbox(workSpriteInput);
            // docs/specs/sandbox-provider-spillover.md. The run picks its provider and holds its slots
            // there, then prepares the work sprite on it. A provider that fails the create is marked
            // down, the run gives its slots back, and it selects again. With no provider that has
            // room, the selection throws the slot error, and `withSandboxSlot` waits.
            for (;;) {
              const budget = Math.max(1, Math.min(budgetMs, remainingMs()));
              await buildSandboxActivities(budget).selectSandboxProvider({
                runId: id,
                tenantId: input.tenantId,
                productId: input.productId,
                repositoryUrl: sandbox.primary.url,
                ...(targetBases.length > 1
                  ? { targetRepositoryUrls: targetBases.slice(1).map((target) => buildRepositoryUrl(input.product.repositoryBaseUrl, target.slug)) }
                  : {}),
              });
              try {
                return await buildSandboxActivities(Math.max(1, Math.min(budgetMs, remainingMs()))).prepareSandbox(workSpriteInput);
              } catch (error) {
                if (!isSandboxProviderDown(error)) throw error;
              }
            }
          });
          if (work === null) {
            if (stopRequested) return { ended: await cancelRun() };
            return { ended: await failRun("RUN_TIMEOUT", timeoutMessage) };
          }
          return { prepared: work };
        } catch (error) {
          // A configuration fault is not an infrastructure fault. The Run ends in
          // `FAILED_CONFIGURATION`, and the retry policy already denied a second attempt.
          if (isConfigurationFault(error)) {
            return {
              ended: await failRun(
                "CONFIGURATION_INVALID",
                withCause(
                  "Factoree could not prepare the sandbox, because the Run configuration is invalid. " +
                    "Repair the repository reference, the reference repositories, or the bootstrap command.",
                  error,
                ),
              ),
            };
          }
          // Preparation is bounded by the remaining budget. A budget that ran out during
          // preparation is a Run timeout, not an internal fault.
          if (remainingMs() > 0) throw error;
          return { ended: await failRun("RUN_TIMEOUT", timeoutMessage) };
        }
      };
      const firstWork = await prepareWorkSprite(firstWorkInput);
      if ("ended" in firstWork) return firstWork.ended;
      let preparedSandbox: PrepareSandboxActivityOutput = firstWork.prepared;
      sprite = preparedSandbox;
      // docs/specs/egress-honesty-and-issue-status.md, DI-21.48. The Run ends FAILED_CONFIGURATION
      // and the post names each host, its reason and where to add it. A reply starts a follow-up run
      // with a new sandbox, which gets the new allow list.
      const failMissingHosts = (role: "refiner" | "implementer", hosts: MissingHost[]): Promise<AgentRunWorkflowResult> =>
        failRun(
          "CONFIGURATION_INVALID",
          renderMissingHostsFailure({
            role,
            hosts,
            productSlug: input.product.productSlug,
            productPageUrl: input.product.productPageUrl ?? null,
            repositorySlug: resolvedContext.primary.slug,
            repositoryListDeclared: preparedSandbox.runtime.sandboxAllowListDeclared === true,
          }),
        );
      // docs/specs/skill-registry.md. A Product with no skill source sends no signal and no proposal.
      if ((input.product.skillRegistry ?? null) !== null || sandbox.organizationSkills !== null) {
        skillSources = {
          skillRegistry: input.product.skillRegistry ?? null,
          organizationSkills:
            input.product.organizationSkillsRepository === null || sandbox.organizationSkills === null
              ? null
              : { slug: input.product.organizationSkillsRepository, repository: sandbox.organizationSkills },
          githubInstallationId: primaryRepositoryInstallationId,
        };
      }

      // A stop that arrived during preparation must prevent the Implementer from starting.
      if (stopRequested) return await cancelRun();
      // Preparation can consume the whole budget. The Run must end here rather than start work
      // it cannot finish.
      if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

      // docs/specs/refiner-agent.md. A fresh refiner reads the work sprite and proposes what done
      // means and how to prove it. The gate decides what freezes, and Factoree takes every other
      // proposal itself (docs/specs/own-proposals-and-parallel-runs.md).
      status = "REFINING";
      await activities.setRunStatus({ runId: id, status });
      let proposal: ProposeRefinementActivityOutput | null;
      const proposeOnce = (afterHang: boolean, unreachableRetry = 0): Promise<ProposeRefinementActivityOutput | null> =>
        runAgentActivity(() =>
          buildUserValidateActivities(remainingMs()).proposeRefinement({
            runId: id,
            tenantId: input.tenantId,
            productId: input.productId,
            // docs/specs/claude-code-runner.md. An old history holds no refiner runner, and its
            // refiner took the validator runner.
            runnerName: preparedSandbox.runtime.refinerRunner ?? preparedSandbox.runtime.validatorRunner,
            spriteId: preparedSandbox.spriteId,
            adapter: preparedSandbox.adapter,
            workspacePath: preparedSandbox.workspacePath,
            primaryPath: preparedSandbox.primaryPath,
            ...setTargetsInput(preparedSandbox),
            // docs/specs/change-sets.md, DI-21.139. The refiner may add a target and cite edges.
            primaryRepository: resolvedContext.primary.slug,
            ...(preparedSandbox.siblings === undefined ? {} : { siblings: preparedSandbox.siblings }),
            ...(refinerTargetsOpen ? { targetsOpen: true } : {}),
            // DI-21.54. The kept human comments are Work Item text too, so the refiner reads them
            // and the gate finds a criterion quoted from a comment.
            workItemText:
              workItemContent?.comments === null || workItemContent?.comments === undefined
                ? `${input.workItem.title}\n\n${workItemDescription}`
                : `${input.workItem.title}\n\n${workItemDescription}\n\n${workItemContent.comments}`,
            goal: refined.goal,
            statedCriteria: refined.acceptanceCriteria,
            contextContract: resolvedContext.document,
            // docs/specs/external-context-delivery.md. Absent in a history from before the delivery.
            contextFiles: preparedSandbox.contextFiles ?? [],
            imageFiles: preparedSandbox.imageFiles ?? [],
            skills: preparedSandbox.skills,
            previewConfigured: preparedSandbox.preview !== null && preparedSandbox.preview.enabled,
            egress: egressOf(preparedSandbox),
            timeoutMs: remainingMs(),
            ...(afterHang ? { afterHang: true } : {}),
            ...(unreachableRetry > 0 ? { unreachableRetry } : {}),
            ...(input.product.refinerCriteriaLimit === undefined ? {} : { criteriaLimit: input.product.refinerCriteriaLimit }),
          }),
        );
      try {
        proposal = await proposeOnce(false);
        proposal = await retryWhileUnreachable("refiner", proposal, (retry) => proposeOnce(false, retry));
        // docs/specs/agent-session-usage-and-hangs.md. A hung refiner gets one fresh session.
        const firstHang = hangOf(proposal);
        if (firstHang !== null && !stopRequested && remainingMs() > 0) {
          await reportHang("refiner", firstHang, "starts one fresh session");
          proposal = await proposeOnce(true);
          proposal = await retryWhileUnreachable("refiner", proposal, (retry) => proposeOnce(true, retry), PROVIDER_UNREACHABLE_ATTEMPTS - 1);
        }
      } catch (error) {
        if (isCancellation(error)) throw error;
        if (isConfigurationFault(error)) {
          return await failRun(
            "CONFIGURATION_INVALID",
            withCause(
              "Factoree could not start the Refiner, because the Run configuration is invalid. " +
                "Repair `validator_runner` in `.factoree/config.yaml`.",
              error,
            ),
          );
        }
        if (remainingMs() > 0) throw error;
        return await failRun("RUN_TIMEOUT", timeoutMessage);
      }
      if (stopRequested) return await cancelRun();
      if (proposal === null) {
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
        return await failRun("REFINEMENT_UNAVAILABLE", "The Refiner did not finish, so Factoree published nothing.");
      }
      const refinerUnreachable = providerUnreachableOf(proposal);
      if (refinerUnreachable !== null) {
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
        return await failProviderUnreachable("refiner", refinerUnreachable);
      }
      const refinerHang = hangOf(proposal);
      if (refinerHang !== null) {
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
        return await failHung("refiner", refinerHang);
      }
      if (proposal.status !== "proposed") {
        // Issue #39, DI-21.66. A proposal over the criteria limit carries a message for the human.
        // A result from an older history holds none and takes the message from before.
        return await failRun(
          "REFINEMENT_UNAVAILABLE",
          proposal.message ?? `Factoree could not use the Refiner proposal. ${proposal.reason} Factoree published nothing.`,
        );
      }
      // docs/specs/egress-honesty-and-issue-status.md, DI-21.48. A host the work needs and the
      // allow list does not hold stops the Run before anything freezes. Only a human widens it.
      const refinerMissingHosts = proposal.missingHosts ?? [];
      if (refinerMissingHosts.length > 0) return await failMissingHosts("refiner", refinerMissingHosts);
      forYourEye = proposal.forYourEye ?? [];
      // A refiner that freezes nothing leaves the criteria the Work Item states.
      const contractCriteria = proposal.accepted.length === 0 ? refined.criteria : proposal.accepted;
      const validationAnswers: string[] = [];
      // docs/specs/own-proposals-and-parallel-runs.md. Every proposal of the gate is determined, so
      // Factoree takes it and asks nobody. The proof pack lists each one for the reviewer.
      for (const decision of proposal.decisions) await takeDecision(decision);

      // docs/specs/change-sets.md, DI-21.140. Each target the gate accepted joins the run at the SHA
      // the refiner read, after the identity check of its base. Its decision is a determined
      // proposal, so nobody is asked. The edges give the merge order (DI-21.141). The work sprite then
      // prepares again with the whole set, from a set snapshot when one exists. The set freezes here,
      // with the Validation Contract that follows.
      if (refinerTargetsOpen && patched(CHANGE_SET_REFINER_PATCH)) {
        let joined = 0;
        for (const added of proposal.addedTargets ?? []) {
          const repository = targetRepositories.find((candidate) => candidate.fullName.toLowerCase() === added.repository.toLowerCase());
          if (repository === undefined) continue;
          await activities.recordRunTarget({
            tenantId: input.tenantId,
            runId: id,
            repositoryId: repository.id,
            selectionReason: `the refiner cited ${added.file} line ${String(added.line)}: ${added.reason}`,
          });
          const identity = await activities.verifyTargetIdentity({
            runId: id,
            tenantId: input.tenantId,
            productId: input.productId,
            productSlug: input.product.productSlug,
            repositoryUrl: buildRepositoryUrl(input.product.repositoryBaseUrl, repository.fullName),
            baseSha: added.commitSha,
            githubInstallationId: repository.githubInstallationId,
          });
          if (stopRequested) return await cancelRun();
          if (!identity.matched) {
            return await endRoutingMismatch(input.product.productSlug, identity.declaredProduct ?? "an unknown Product");
          }
          await activities.recordRunTargetFacts({ tenantId: input.tenantId, runId: id, repositoryId: repository.id, baseSha: added.commitSha });
          if (runTargets.length === 0) {
            runTargets = [{ id: primaryRepositoryId, fullName: resolvedContext.primary.slug, githubInstallationId: primaryRepositoryInstallationId }];
          }
          runTargets.push({ id: repository.id, fullName: repository.fullName, githubInstallationId: repository.githubInstallationId });
          targetBases.push({
            id: repository.id,
            fullName: repository.fullName,
            githubInstallationId: repository.githubInstallationId,
            slug: repository.fullName,
            sha: added.commitSha,
          });
          await takeDecision(added.decision);
          joined += 1;
        }
        const edges = proposal.edges ?? [];
        if (runTargets.length > 1 && edges.length > 0) {
          runEdges = edges.map((edge) => ({ provider: edge.provider, consumer: edge.consumer }));
          const order = await activities.recordRunTargetEdges({ tenantId: input.tenantId, runId: id, edges });
          const decision = mergeOrderDecision(order, edges);
          if (decision !== null) await takeDecision(decision);
        }
        if (joined > 0) {
          if (stopRequested) return await cancelRun();
          // DI-21.143. The Context Contract of the run lists every target, so the context resolves
          // again for the set before the Validation Contract freezes. Each repository stays at the
          // SHA the run already pinned, and an added target at the SHA the refiner read.
          if (patched(CHANGE_SET_CONTEXT_PATCH)) {
            const pinnedOf = (slug: string, sha: string) => ({ ...repositoryRef(slug), ref: sha });
            const setContext = await resolveContextLoop({
              primaryRepository: pinnedOf(resolvedContext.primary.slug, resolvedContext.primary.sha),
              referenceRepositories: resolvedContext.references.map((reference) => pinnedOf(reference.slug, reference.sha)),
              targetRepositories: targetBases
                .slice(1)
                .map((target) => ({ ...pinnedOf(target.slug, target.sha), githubInstallationId: target.githubInstallationId })),
              supersedes: resolvedContext.sha256,
            });
            if ("ended" in setContext) return setContext.ended;
            resolvedContext = setContext.resolved;
            if (stopRequested) return await cancelRun();
            prepareInput = {
              ...prepareInput,
              ...(resolvedContext.deliveryRefs === undefined ? {} : { contextRefs: resolvedContext.deliveryRefs }),
            };
          }
          prepareInput = {
            ...prepareInput,
            targets: targetBases.map((target) => ({
              repository: target.slug,
              url: buildRepositoryUrl(input.product.repositoryBaseUrl, target.slug),
              ref: target.sha,
              githubInstallationId: target.githubInstallationId,
            })),
          };
          status = "PREPARING";
          await activities.setRunStatus({ runId: id, status });
          const again = await prepareWorkSprite(prepareInput);
          if ("ended" in again) return again.ended;
          preparedSandbox = again.prepared;
          sprite = preparedSandbox;
          if (stopRequested) return await cancelRun();
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
        }
      }

      // docs/specs/refiner-agent.md. The Validation Contract freezes after the refiner and before
      // the Implementer. SDD section 24 requires the contract to freeze before implementation
      // starts. The loop ends because `askAndWait` is bounded by the question rounds and by the
      // budget.
      let validation: Awaited<ReturnType<Activities["buildValidationContract"]>>;
      for (;;) {
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "BUILDING_VALIDATION_CONTRACT";
        await activities.setRunStatus({ runId: id, status });

        validation = await validationActivities.buildValidationContract({
          runId: id,
          tenantId: input.tenantId,
          productId: input.productId,
          workItem: input.workItem.issueId ?? id,
          goal: refined.goal,
          acceptanceCriteria: contractCriteria,
          humanAssertions: validationAnswers,
        });

        if (validation.status === "ready") {
          // The output type permits a `ready` result with a null `sha256`. The workflow must not
          // start implementation on that combination, because no confirmed frozen contract exists.
          if (validation.sha256 === null) {
            return await failRun(
              "VALIDATION_UNRESOLVED",
              "Factoree could not confirm the Validation Contract froze, so it published nothing.",
            );
          }
          validationContractVersion = validation.sha256;
          break;
        }

        await notify(() =>
          activities.postProgress({
            sessionId: input.agentSessionId,
            message: validation.summary,
          }),
        );

        // SDD section 9 item 5. No observable success assertion exists, so implementation must
        // not start. The human states one, and it becomes an assertion of the contract.
        const question = validation.question;
        if (question === null) {
          return await failRun(
            "VALIDATION_UNRESOLVED",
            "Factoree could not define success for this Work Item, and it published nothing.",
          );
        }
        const proceeded = await askAndWait(question.id, question.question);
        if (stopRequested) return await cancelRun();
        if (!proceeded) {
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          return await failRun(
            "VALIDATION_UNRESOLVED",
            "Factoree could not start, because this Work Item states no observable success " +
              "assertion. Factoree must not invent product behavior, so it published nothing.",
          );
        }
        const answer = decisions[decisions.length - 1]?.answer ?? "";
        if (answer.trim() !== "") validationAnswers.push(answer);
      }

      await notify(() =>
        activities.postProgress({ sessionId: input.agentSessionId, message: validation.summary }),
      );

      // docs/specs/refiner-agent.md. An assertion that no automated check can answer ends an L3
      // Run with VALIDATION_MANUAL_REQUIRED anyway. Stopping here spends no agent time on it.
      if (validation.manualAssertionIds.length > 0) {
        return await failRun(
          "VALIDATION_MANUAL_REQUIRED",
          "Factoree cannot check these assertions automatically: " +
            `${validation.manualAssertionIds.join(", ")}. Rewrite each one as an observable result ` +
            "(a command, an HTTP response, or a page state) and delegate again. Factoree started no " +
            "implementation and published nothing.",
        );
      }

      // A stop that arrived while the contract was built must prevent the Implementer.
      if (stopRequested) return await cancelRun();
      if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

      // One Implementer attempt plus its verification. SDD section 42 bounds the number of
      // repairs, so the loop can never run without end.
      let attempt = FIRST_IMPLEMENTER_ATTEMPT;
      // docs/specs/pr-review-merge-and-deploy.md. The first attempt of a PR reviewer follow-up repairs
      // the findings the triage kept.
      let repairFindings: string[] = initialRepairFindings;
      // docs/specs/change-sets.md, DI-21.142. The repositories outside the frozen set an implementer
      // named, and the finding each later attempt reads.
      const frozenSetRepositories = new Set<string>();
      const frozenSetFindings: string[] = [];
      let repairCount = 0;
      const maxRepairs = preparedSandbox.runtime.repairMaxAttempts;
      // Issue #43, DI-21.67. A spent budget names its size and where it comes from. Only the
      // message text changes, so a running history replays the same commands.
      const spentBudget = describeSpentRepairBudget(maxRepairs, preparedSandbox.runtime.repairBudgetSource);
      // docs/specs/agent-session-usage-and-hangs.md. The hung Implementer session the next attempt
      // resumes, and whether the current step already resumed one. One step allows one hang.
      let continueSession: AgentSessionRef | null = null;
      let resumedAfterHang = false;
      // docs/specs/provider-unreachable.md. The consecutive Implementer sessions that could not reach
      // the model provider: 0, 1 or 2. It is a counter of the workflow, so a replay takes the same ladder.
      let unreachableRetries = 0;

      // SDD section 46 needs these two values after the loop ends, and the loop scope does not
      // survive the `break`. The successful pass writes them just before it breaks.
      let publishedChangedFiles: string[] = [];
      let publishedVerificationSummary = "";
      // The git tree the independent review examined. The publication refuses a tree that
      // differs, so a write after the review can never reach GitHub.
      let publishedWorktreeSha = "";
      // SDD section 68 and section 47 need these values after the loop ends. The successful pass
      // writes them just before it breaks, exactly as the three values above do.
      let publishedVerificationPassed = false;
      let publishedValidationPassed = false;
      // docs/specs/run-recovery.md. True when the published attempt's only unproven assertions are
      // unstable. Such a run publishes a draft.
      let publishedValidationUnstableOnly = false;
      let publishedBlockingCount = 0;
      let publishedReviewVerdict: "pass" | "fail" = "fail";
      let publishedReviewPasses = 0;
      // The attempt number of the last Reviewer session. The Proof Pack needs it, because a
      // passing review writes no finding row and the stored rows cannot name that pass.
      let publishedReviewAttempt = 0;
      // SDD section 24 and section 68. The moment the FIRST Implementer attempt started. The
      // completion invariant compares it with the freeze moment, because the clause names an
      // order. A later repair attempt must not move it.
      let implementationStartedAt: string | null = null;
      // The number of Reviewer sessions this Run ran. The attempt counter is not the same value,
      // because a repair that verification or validation asked for raises the attempt without
      // reaching a review. The Proof Pack reports this count to a human, so it must be exact.
      let reviewPasses = 0;
      let publishedPreviewUrl: string | null = null;
      let publishedFakes: Array<{ service: string; name: string; target?: string }> = [];
      // docs/specs/change-sets.md, DI-21.148. The pairs the last set check tested alone, with the reason.
      let publishedSetCheckNotes: string[] = [];
      let publishedChangeDescription = "";
      // docs/specs/proof-pack-and-visual-evidence.md. The gap the human accepted at refinement.
      // docs/specs/run-recovery.md. A follow-up whose reply replaced the browser checks of the
      // failed run captures no visual evidence, and the human must read why.
      const droppedBrowserChecks = input.followUpBrowserAssertions ?? [];
      const visualEvidenceGap =
        proposal.visualEvidenceGap ??
        (droppedBrowserChecks.length > 0 && (validation.browserAssertionIds ?? ["unknown"]).length === 0
          ? `No visual evidence: the follow-up guidance replaced the browser ${droppedBrowserChecks.length === 1 ? "check" : "checks"} ` +
            `${droppedBrowserChecks.join(", ")} of the failed run, and this run froze no browser check. Look at the visible change yourself.`
          : null);

      for (;;) {
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "IMPLEMENTING";
        if (implementationStartedAt === null) {
          implementationStartedAt = new Date(Date.now()).toISOString();
        }
        await activities.setRunStatus({ runId: id, status });

        const implementation = await runImplementer({
          prepared: preparedSandbox,
          goal: sandbox.goal,
          attempt,
          repairFindings,
          contextContract: resolvedContext.document,
          requiredContext: resolvedContext.requiredContext,
          validationContract: validation.document,
          continueSession,
        });
        continueSession = null;

        // A stop that arrived while the Implementer ran must end the Run here.
        if (stopRequested) return await cancelRun();

        // docs/specs/egress-honesty-and-issue-status.md, DI-21.48. A host the implementer named and
        // the allow list does not hold ends the Run, whatever else the session reported.
        const implementerMissingHosts = implementation?.missingHosts ?? [];
        if (implementerMissingHosts.length > 0) return await failMissingHosts("implementer", implementerMissingHosts);

        // docs/specs/change-sets.md, DI-21.142. The set froze with the Validation Contract. A
        // repository the implementer names outside it is a new criterion: Factoree lists it as not
        // built, and each later attempt reads the finding.
        if (patched(CHANGE_SET_REFINER_PATCH)) {
          for (const missing of implementation?.missingRepositories ?? []) {
            const name = missing.repository.trim();
            const key = name.toLowerCase();
            if (name === "" || frozenSetRepositories.has(key) || targetBases.some((target) => target.slug.toLowerCase() === key)) continue;
            frozenSetRepositories.add(key);
            const reason = missing.reason.trim().replace(/[.\s]+$/, "");
            await takeDecision({
              kind: "not_built",
              statement: `did not build the change to ${name}`,
              reason: `the targets froze with the Validation Contract, and a change to another repository is a new criterion${reason === "" ? "" : `: ${reason}`}`,
            });
            frozenSetFindings.push(
              `${name} is not a target of this Run, and the targets froze with the Validation Contract. Make the change work in the targets alone. Factoree lists ${name} as not built.`,
            );
          }
        }

        // docs/specs/provider-unreachable.md. The provider could not be reached. The first retry is a
        // fresh session in the same sandbox, the second one runs in a fresh sandbox, and a third
        // failure ends the Run. None of them uses the repair budget.
        const implementerUnreachable = providerUnreachableOf(implementation);
        if (implementation !== null && implementerUnreachable !== null) {
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          if (unreachableRetries >= PROVIDER_UNREACHABLE_ATTEMPTS - 1) {
            return await failProviderUnreachable("implementer", implementerUnreachable);
          }
          unreachableRetries += 1;
          // A fresh sandbox starts from the base commit, so it is only right while the Run holds no
          // earlier change. After a repair the same sandbox keeps the work, and a fresh session runs there.
          const freshSandbox = unreachableRetries === 2 && repairCount === 0;
          await notify(() =>
            activities.postProgress({
              sessionId: input.agentSessionId,
              message:
                `The Implementer session could not reach the model provider, so Factoree starts one fresh session ` +
                `${freshSandbox ? "in a fresh sandbox" : "in the same sandbox"} (retry ${unreachableRetries} of ${PROVIDER_UNREACHABLE_ATTEMPTS - 1}).`,
            }),
          );
          if (freshSandbox) {
            status = "PREPARING";
            await activities.setRunStatus({ runId: id, status });
            const again = await prepareWorkSprite(workInputOf(prepareInput));
            if ("ended" in again) return again.ended;
            preparedSandbox = again.prepared;
            sprite = preparedSandbox;
            if (stopRequested) return await cancelRun();
            if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          }
          attempt += 1;
          continue;
        }
        unreachableRetries = 0;

        // docs/specs/agent-session-usage-and-hangs.md. The first hang resumes the session once
        // with "continue", and that attempt uses the repair budget. A second hang in the same
        // step ends the Run.
        const implementerHang = hangOf(implementation);
        if (implementation !== null && implementerHang !== null) {
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          if (resumedAfterHang) return await failHung("implementer", implementerHang);
          if (repairCount >= maxRepairs) {
            return await failHung(
              "implementer",
              implementerHang,
              `and ${spentBudget.clause}, so Factoree cannot resume it`,
              spentBudget.hint,
            );
          }
          await reportHang("implementer", implementerHang, "resumes it once");
          repairCount += 1;
          signalRepairs = repairCount;
          attempt += 1;
          resumedAfterHang = true;
          continueSession = {
            sessionId: implementation.sessionId,
            processId: implementation.processId,
            runner: implementation.runner,
          };
          status = "REPAIRING";
          await activities.setRunStatus({ runId: id, status, repairCount, repairReason: "AGENT_HUNG" });
          continue;
        }
        resumedAfterHang = false;

        // SDD section 49: a semantic outcome drives a workflow decision. A failed attempt must
        // not fall into the wait and become a timeout.
        if (implementation === null || !implementation.completed) {
          // SDD section 50: a Run that reaches the maximum duration fails with `RUN_TIMEOUT`.
          // The runner reports a cancelled agent process as an incomplete attempt, so the
          // deadline decides which of the two outcomes this is.
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          // docs/specs/provider-unreachable.md. The message carries the agent's own error.
          const cause = patched(PROVIDER_UNREACHABLE_PATCH) ? (implementation?.summary ?? "").trim() : "";
          return await failRun(
            "IMPLEMENTATION_FAILED",
            `The Implementer did not complete the change. Factoree ended the Run.${cause === "" ? "" : ` Agent output: ${cause}`}`,
          );
        }

        // SDD section 35. The agent has now claimed success. The claim does not decide what
        // follows. Only the configured commands do.
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        // docs/specs/check-isolation.md. The Implementer controlled the work sprite. Every check
        // runs in a new sprite built from the base SHA plus the captured patch.
        const previousCheck: PrepareCheckSandboxActivityOutput | null = checkSandbox;
        let checked: PrepareCheckSandboxActivityOutput;
        try {
          const check = await withSandboxSlot((budgetMs) => buildSandboxActivities(budgetMs).prepareCheckSandbox({
            ...prepareInput,
            work: {
              spriteId: preparedSandbox.spriteId,
              adapter: preparedSandbox.adapter,
              workspacePath: preparedSandbox.workspacePath,
              primaryPath: preparedSandbox.primaryPath,
              baseSha: preparedSandbox.baseSha,
              ...setTargetsInput(preparedSandbox),
            },
            previous:
              previousCheck === null
                ? null
                : {
                    spriteId: previousCheck.spriteId,
                    adapter: previousCheck.adapter,
                    workspacePath: previousCheck.workspacePath,
                  },
            attempt,
          }));
          if (check === null) {
            if (stopRequested) return await cancelRun();
            return await failRun("RUN_TIMEOUT", timeoutMessage);
          }
          checked = check;
        } catch (error) {
          if (isConfigurationFault(error)) {
            return await failRun(
              "CONFIGURATION_INVALID",
              withCause(
                "Factoree could not prepare the check sandbox, because the Run configuration is " +
                  "invalid. Repair the bootstrap command or the repository reference.",
                error,
              ),
            );
          }
          if (remainingMs() > 0) throw error;
          return await failRun("RUN_TIMEOUT", timeoutMessage);
        }
        checkSandbox = checked;
        if (stopRequested) return await cancelRun();
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "VERIFYING";
        await activities.setRunStatus({ runId: id, status });

        /**
         * docs/specs/run-speed.md. Builds the reviewer's check sprite of this attempt with the patch
         * the first check sprite holds, and deletes the reviewer's sprite of an earlier attempt.
         */
        const prepareReviewSprite = (expectedPatchSha256: string): Promise<PrepareCheckSandboxActivityOutput | null> => {
          const previousReview = reviewSandbox;
          const reviewAttempt = attempt;
          return withSandboxSlot((budgetMs) =>
            buildSandboxActivities(budgetMs).prepareCheckSandbox({
              ...prepareInput,
              work: {
                spriteId: preparedSandbox.spriteId,
                adapter: preparedSandbox.adapter,
                workspacePath: preparedSandbox.workspacePath,
                primaryPath: preparedSandbox.primaryPath,
                baseSha: preparedSandbox.baseSha,
                ...setTargetsInput(preparedSandbox),
              },
              previous:
                previousReview === null
                  ? null
                  : {
                      spriteId: previousReview.spriteId,
                      adapter: previousReview.adapter,
                      workspacePath: previousReview.workspacePath,
                    },
              attempt: reviewAttempt,
              expectedPatchSha256,
            }),
          );
        };

        // docs/specs/early-review-sprite.md. The reviewer's check sprite builds while verify runs,
        // and not after it passes. The build runs outside every cancellable scope: the activity
        // sends no heartbeat, so a cancel never reaches it, and the sprite it builds would belong
        // to no Run. A stop or the end of the Run waits for it instead.
        let earlyReview: Promise<ReviewSpriteBuild> | null = null;
        if (patched(EARLY_REVIEW_SPRITE_PATCH) && patched(PARALLEL_REVIEW_PATCH)) {
          const earlier = reviewBuild;
          reviewBuild = null;
          if (earlier !== null) await earlier;
          const expected = checked.patchSha256;
          earlyReview = CancellationScope.nonCancellable(async (): Promise<ReviewSpriteBuild> => {
            try {
              const sprite = await prepareReviewSprite(expected);
              if (sprite === null) return { kind: "unavailable" };
              reviewSandbox = sprite;
              return { kind: "sprite", sprite };
            } catch (error) {
              return { kind: "error", error };
            }
          });
          reviewBuild = earlyReview;
        }

        const verifyActivities = buildVerifyActivities(remainingMs());
        let verification: VerifyActivityOutput;
        try {
          verification = await verifyActivities.verify({
            runId: id,
            tenantId: input.tenantId,
            productId: input.productId,
            spriteId: checked.spriteId,
            adapter: checked.adapter,
            workspacePath: checked.workspacePath,
            primaryPath: checked.primaryPath,
            commands: checked.verifyCommands,
            timeoutMs: remainingMs(),
            attempt,
            // docs/specs/change-sets.md, DI-21.146. Each target of a change set verifies with its own stack.
            ...(checked.setCheck === undefined
              ? {}
              : { stacks: checked.setCheck.targets.map((target) => ({ repository: target.repository, path: target.path, services: target.services })) }),
          });
        } catch (error) {
          // Verification is bounded by the remaining budget, the same way preparation is. A
          // budget that ran out during verification is a Run timeout, not an internal fault.
          if (remainingMs() > 0) throw error;
          return await failRun("RUN_TIMEOUT", timeoutMessage);
        }

        await notify(() =>
          activities.postProgress({
            sessionId: input.agentSessionId,
            message: verification.summary,
          }),
        );

        // docs/specs/early-review-sprite.md. A failed verify ends the attempt, so its reviewer's
        // check sprite holds a patch the repair replaces. The build ends in the background and the
        // sprite goes at once, so the repair does not wait and the sprite keeps no slot.
        if (!verification.passed && earlyReview !== null) {
          const build = earlyReview;
          reviewBuild = CancellationScope.nonCancellable(async () => {
            const outcome = await build;
            if (outcome.kind !== "sprite") return;
            const sprite = outcome.sprite;
            try {
              await cancelActivities.releaseCheckSandbox({
                runId: id,
                spriteId: sprite.spriteId,
                adapter: sprite.adapter,
                workspacePath: sprite.workspacePath,
              });
              if (reviewSandbox === sprite) reviewSandbox = null;
            } catch {
              // The sprite stays the reviewer's sprite of the Run, so the next build or the end of
              // the Run deletes it.
            }
          });
        }

        if (stopRequested) return await cancelRun();

        if (!verification.passed) {
          // SDD section 42. A failing check enters repair while budget remains. No third repair
          // occurs when the limit is two.
          if (repairCount >= maxRepairs) {
            return await failRun(
              "VERIFICATION_FAILED",
              `Deterministic verification did not pass, and ${spentBudget.clause}. ${spentBudget.hint} ` +
                `${verification.summary} ${setResultsOf({ verification: verification.checks })}Factoree published nothing.`,
            );
          }
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

          repairCount += 1;
          signalRepairs = repairCount;
          attempt += 1;
          repairFindings = [...frozenSetFindings, ...verification.failures];
          status = "REPAIRING";
          await activities.setRunStatus({
            runId: id,
            status,
            repairCount,
            repairReason: "VERIFICATION",
          });
          await announceRepair(repairCount, maxRepairs, "deterministic verification did not pass", repairFindings.length);
          continue;
        }

        // SDD section 48 and SDD section 49. Deterministic verification passed, so the Run
        // enters USER_VALIDATING. A fresh validator session checks the frozen Validation
        // Contract, inside the same bounded loop, with the current implementation attempt.
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        // docs/specs/run-speed.md, amending SDD section 40. Verification passed, so the reviewer
        // starts now in its own check sprite, beside user validation. A preview build in the same
        // sprite can rewrite tracked files, which the reviewer guard would read as a reviewer
        // write. The reviewer reads the verification summary and no validation evidence.
        let reviewBranch: Promise<ReviewBranchOutcome> | null = null;
        if (patched(PARALLEL_REVIEW_PATCH)) {
          reviewPasses += 1;
          const reviewAttempt = attempt;
          const verified = checked;
          const verificationSummary = verification.summary;
          const early = earlyReview;
          const scope = new CancellationScope({ cancellable: true });
          const branch = scope.run(async (): Promise<ReviewBranchOutcome> => {
            try {
              let sprite: PrepareCheckSandboxActivityOutput | null;
              if (early !== null) {
                const built = await early;
                if (built.kind === "error") return { kind: "error", error: built.error };
                sprite = built.kind === "sprite" ? built.sprite : null;
              } else {
                sprite = await prepareReviewSprite(verified.patchSha256);
              }
              if (sprite === null) return { kind: "unavailable" };
              reviewSandbox = sprite;
              const reviewInput = {
                prepared: sprite,
                goal: sandbox.goal,
                attempt: reviewAttempt,
                contextContract: resolvedContext.document,
                constraints: refined.constraints,
                verificationSummary,
              };
              let result = await runReview(reviewInput);
              result = await retryWhileUnreachable("reviewer", result, (retry) =>
                runReview({ ...reviewInput, unreachableRetry: retry }),
              );
              // docs/specs/agent-session-usage-and-hangs.md. A hung Reviewer gets one fresh session
              // in the same review pass.
              const hang = hangOf(result);
              if (hang !== null && !stopRequested && remainingMs() > 0) {
                await reportHang("reviewer", hang, "starts one fresh session");
                result = await runReview({ ...reviewInput, afterHang: true });
                result = await retryWhileUnreachable(
                  "reviewer",
                  result,
                  (retry) => runReview({ ...reviewInput, afterHang: true, unreachableRetry: retry }),
                  PROVIDER_UNREACHABLE_ATTEMPTS - 1,
                );
              }
              return result === null ? { kind: "unavailable" } : { kind: "review", review: result };
            } catch (error) {
              return { kind: "error", error };
            }
          });
          liveReview = { scope, branch };
          reviewBranch = branch;
        }

        /** The reviewer beside user validation, once it ended, or null on the serial path. */
        const awaitReview = async (): Promise<ReviewBranchOutcome | null> => {
          if (reviewBranch === null) return null;
          const outcome = await reviewBranch;
          liveReview = null;
          return outcome;
        };

        status = "USER_VALIDATING";
        await activities.setRunStatus({ runId: id, status });

        let userValidation: UserValidateActivityOutput;
        try {
          let result = await runUserValidate({
            prepared: checked,
            goal: sandbox.goal,
            attempt,
          });
          // A stop that arrived while the validator ran must end the Run here.
          if (stopRequested) return await cancelRun();
          result = await retryWhileUnreachable("validator", result, (retry) =>
            runUserValidate({ prepared: checked, goal: sandbox.goal, attempt, unreachableRetry: retry }),
          );
          if (stopRequested) return await cancelRun();
          // docs/specs/agent-session-usage-and-hangs.md. A hung validator gets one fresh session.
          const validatorHang = hangOf(result);
          if (validatorHang !== null && remainingMs() > 0) {
            await reportHang("validator", validatorHang, "starts one fresh session");
            result = await runUserValidate({ prepared: checked, goal: sandbox.goal, attempt, afterHang: true });
            result = await retryWhileUnreachable(
              "validator",
              result,
              (retry) => runUserValidate({ prepared: checked, goal: sandbox.goal, attempt, afterHang: true, unreachableRetry: retry }),
              PROVIDER_UNREACHABLE_ATTEMPTS - 1,
            );
            if (stopRequested) return await cancelRun();
          }
          if (result === null) {
            // The pass ended with no result and no stop signal. The budget decides why.
            if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
            throw ApplicationFailure.nonRetryable("the userValidate activity returned no result");
          }
          userValidation = result;
        } catch (error) {
          // User validation is bounded by the remaining budget, the same way verification is. A
          // budget that ran out during the pass is a Run timeout, not an internal fault.
          if (isCancellation(error)) throw error;
          // A validator runner the Project names but no worker registers is a configuration
          // fault. The Run ends in `FAILED_CONFIGURATION`, not in an internal error.
          if (isConfigurationFault(error)) {
            return await failRun(
              "CONFIGURATION_INVALID",
              withCause(
                "Factoree could not start the User Validator, because the Run configuration is " +
                  "invalid. Repair `validator_runner` in `.factoree/config.yaml`.",
                error,
              ),
            );
          }
          if (remainingMs() > 0) throw error;
          return await failRun("RUN_TIMEOUT", timeoutMessage);
        }

        const validatorUnreachable = providerUnreachableOf(userValidation);
        if (validatorUnreachable !== null) {
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          return await failProviderUnreachable("validator", validatorUnreachable);
        }
        const validatorHang = hangOf(userValidation);
        if (validatorHang !== null) {
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          return await failHung("validator", validatorHang);
        }

        await notify(() =>
          activities.postProgress({
            sessionId: input.agentSessionId,
            message: userValidation.summary,
          }),
        );

        if (stopRequested) return await cancelRun();

        // docs/specs/run-recovery.md. When every assertion that did not pass is unstable, no repair
        // can help and nothing failed. The run continues to the review and a draft pull request.
        const unstableOnly =
          !userValidation.passed &&
          userValidation.hasUnstable === true &&
          !userValidation.hasFailure &&
          !userValidation.hasBlocked &&
          !userValidation.hasManual &&
          patched(UNSTABLE_ASSERTION_PATCH);
        if (!userValidation.passed && !unstableOnly) {
          // SDD section 36. Only a failing assertion can be repaired. A blocked check, or a check
          // that needs a human, cannot be fixed by another Implementer attempt.
          if (userValidation.hasFailure) {
            // docs/specs/run-speed.md. The reviewer of the same attempt usually ended first. Its
            // blockers join the validation failures, so one repair fixes both.
            const parallel = await awaitReview();
            if (stopRequested) return await cancelRun();
            const reviewFindings =
              parallel?.kind === "review" &&
              hangOf(parallel.review) === null &&
              parallel.review.reportUsable &&
              !parallel.review.passed
                ? parallel.review.failures
                : [];
            // SDD section 42 bounds repairs per Run, and the repair shares the budget
            // deterministic verification already counts.
            if (repairCount >= maxRepairs) {
              return await failRun(
                "VALIDATION_FAILED",
                `User validation did not pass, and ${spentBudget.clause}. ${spentBudget.hint} ` +
                  `${userValidation.summary} ${setResultsOf({ validation: userValidation.results, ...(userValidation.inBetweenFailedConsumers === undefined ? {} : { inBetweenFailed: userValidation.inBetweenFailedConsumers }) })}Factoree published nothing.`,
              );
            }
            if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

            repairCount += 1;
            signalRepairs = repairCount;
            attempt += 1;
            repairFindings = [...frozenSetFindings, ...userValidation.failures, ...reviewFindings];
            status = "REPAIRING";
            await activities.setRunStatus({
              runId: id,
              status,
              repairCount,
              repairReason: "VALIDATION",
            });
            await announceRepair(
              repairCount,
              maxRepairs,
              reviewFindings.length === 0
                ? "user validation did not pass"
                : "user validation did not pass and the review found blocking findings",
              repairFindings.length,
            );
            continue;
          }

          if (userValidation.hasBlocked) {
            return await failRun(
              "VALIDATION_BLOCKED",
              "Factoree could not run at least one user validation check, so it proved nothing. " +
                `${userValidation.summary} A repair cannot help. Factoree published nothing.`,
            );
          }

          // SDD section 36 forbids completion of an L3 Run without a human. The Run must say so
          // now, rather than wait for the residual wait to end it with a timeout.
          if (userValidation.hasManual) {
            return await failRun(
              "VALIDATION_MANUAL_REQUIRED",
              "At least one user validation assertion needs a human, so Factoree cannot complete " +
                `this Run on its own. ${userValidation.summary} Factoree published nothing.`,
            );
          }

          // A pass that did not pass must report at least one failed, blocked, or manual
          // assertion. Any other output is an internal fault, not a validation outcome.
          throw ApplicationFailure.nonRetryable(
            "User validation did not pass, and reported no failed, blocked, or manual assertion.",
            "USER_VALIDATION_INCONSISTENT",
          );
        }

        // SDD section 40 and section 49. User validation passed, so a fresh Reviewer session
        // examines the change against the fixed review baseline of SDD section 43.
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "REVIEWING";
        await activities.setRunStatus({ runId: id, status });

        let review: ReviewActivityOutput;
        const parallel = await awaitReview();
        if (parallel !== null) {
          if (stopRequested) return await cancelRun();
          if (parallel.kind === "error") {
            const error = parallel.error;
            if (isCancellation(error)) throw error;
            // A reviewer runner the Project names but no worker registers is a configuration
            // fault, exactly as on the serial path below.
            if (isConfigurationFault(error)) {
              return await failRun(
                "CONFIGURATION_INVALID",
                withCause(
                  "Factoree could not start the Reviewer, because the Run configuration is " +
                    "invalid. Repair `reviewer_runner` in `.factoree/config.yaml`.",
                  error,
                ),
              );
            }
            if (remainingMs() > 0) throw error;
            return await failRun("RUN_TIMEOUT", timeoutMessage);
          }
          if (parallel.kind === "unavailable") {
            if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
            throw ApplicationFailure.nonRetryable("the review activity returned no result");
          }
          review = parallel.review;
        } else try {
          reviewPasses += 1;
          const reviewInput = {
            prepared: checked,
            goal: sandbox.goal,
            attempt,
            contextContract: resolvedContext.document,
            constraints: refined.constraints,
            verificationSummary: verification.summary,
            validationEvidence: userValidation.results.map(
              (entry) => `${entry.assertionId}: ${entry.result}. ${entry.reason}`,
            ),
          };
          let result = await runReview(reviewInput);
          if (stopRequested) return await cancelRun();
          result = await retryWhileUnreachable("reviewer", result, (retry) =>
            runReview({ ...reviewInput, unreachableRetry: retry }),
          );
          if (stopRequested) return await cancelRun();
          // docs/specs/agent-session-usage-and-hangs.md. A hung Reviewer gets one fresh session in
          // the same review pass.
          const reviewerHang = hangOf(result);
          if (reviewerHang !== null && remainingMs() > 0) {
            await reportHang("reviewer", reviewerHang, "starts one fresh session");
            result = await runReview({ ...reviewInput, afterHang: true });
            result = await retryWhileUnreachable(
              "reviewer",
              result,
              (retry) => runReview({ ...reviewInput, afterHang: true, unreachableRetry: retry }),
              PROVIDER_UNREACHABLE_ATTEMPTS - 1,
            );
            if (stopRequested) return await cancelRun();
          }
          if (result === null) {
            if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
            throw ApplicationFailure.nonRetryable("the review activity returned no result");
          }
          review = result;
        } catch (error) {
          if (isCancellation(error)) throw error;
          // A reviewer runner the Project names but no worker registers is a configuration
          // fault, exactly as the validator runner is.
          if (isConfigurationFault(error)) {
            return await failRun(
              "CONFIGURATION_INVALID",
              withCause(
                "Factoree could not start the Reviewer, because the Run configuration is " +
                  "invalid. Repair `reviewer_runner` in `.factoree/config.yaml`.",
                error,
              ),
            );
          }
          if (remainingMs() > 0) throw error;
          return await failRun("RUN_TIMEOUT", timeoutMessage);
        }

        const reviewerUnreachable = providerUnreachableOf(review);
        if (reviewerUnreachable !== null) {
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          return await failProviderUnreachable("reviewer", reviewerUnreachable);
        }
        const reviewerHang = hangOf(review);
        if (reviewerHang !== null) {
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          return await failHung("reviewer", reviewerHang);
        }

        await notify(() =>
          activities.postProgress({ sessionId: input.agentSessionId, message: review.summary }),
        );

        if (stopRequested) return await cancelRun();

        // DI-8.7. A report Factoree cannot read proves nothing, and a repair
        // cannot fix it. SDD section 68 forbids completion without a review, so the Run ends.
        if (!review.reportUsable) {
          return await failRun(
            "REVIEW_UNAVAILABLE",
            "Factoree could not obtain a usable independent review, so it proved nothing about " +
              `this change. ${review.reportProblem ?? ""} Factoree published nothing.`.trim(),
          );
        }

        if (review.passed) {
          publishedChangedFiles = review.changedFiles;
          publishedVerificationSummary = verification.summary;
          publishedWorktreeSha = review.worktreeSha;
          publishedVerificationPassed = verification.passed;
          publishedValidationPassed = userValidation.passed;
          publishedValidationUnstableOnly = unstableOnly;
          publishedBlockingCount = review.blockingCount;
          publishedReviewVerdict = review.verdict;
          signalReviewVerdict = review.verdict;
          publishedReviewPasses = reviewPasses;
          publishedReviewAttempt = attempt;
          publishedPreviewUrl = userValidation.previewUrl;
          publishedFakes = userValidation.fakes ?? [];
          publishedSetCheckNotes = userValidation.setCheckNotes ?? [];
          publishedChangeDescription = review.changeDescription;
          break;
        }

        // SDD section 42. A blocking finding enters the same bounded repair loop.
        if (repairCount >= maxRepairs) {
          return await failRun(
            "REVIEW_BLOCKING_FINDINGS",
            `The independent review rejected this change, and ${spentBudget.clause}. ${spentBudget.hint} ` +
              `${review.summary} Factoree published nothing.`,
          );
        }
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        repairCount += 1;
        signalRepairs = repairCount;
        attempt += 1;
        repairFindings = [...frozenSetFindings, ...review.failures];
        status = "REPAIRING";
        await activities.setRunStatus({ runId: id, status, repairCount, repairReason: "REVIEW" });
        await announceRepair(repairCount, maxRepairs, "the independent review found blocking findings", repairFindings.length);
        continue;
      }

      // SDD section 49. The independent review passed, so Factoree captures the verified patch,
      // proves the target branch has not moved, and publishes. SDD section 46 keeps every step of
      // the publication on the control plane, because SDD section 29 denies git remote write from
      // an agent.
      if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
      if (stopRequested) return await cancelRun();

      // SDD section 68. Every clause that can hold before publication is checked here, so a broken
      // clause stops the Run before a pull request exists, not after.
      // docs/specs/autonomy-levels.md and check-isolation.md. L2 opens a draft. So does a patch
      // that changes a file that defines a check, and a run with an unstable assertion
      // (docs/specs/run-recovery.md). docs/specs/pr-review-merge-and-deploy.md: L4 publishes a
      // ready pull request as L3 does, and its PR workflow turns on auto-merge.
      const publishDraft =
        (refined.autonomyLevel !== "L3" && refined.autonomyLevel !== "L4") ||
        (checkSandbox?.checkDefiningFiles.length ?? 0) > 0 ||
        publishedValidationUnstableOnly;
      const unmetBeforePublication = prePublicationFailures({
        workItemReady: refined.status === "ready",
        contextContractVersion,
        unresolvedConflict: resolvedContext.unresolvedConflict !== null,
        validationContractVersion,
        validationContractFrozenAt: validation.frozenAt,
        implementationStartedAt,
        validationPassed: publishedValidationPassed,
        validationUnstableOnly: publishedValidationUnstableOnly,
        draft: publishDraft,
        verificationPassed: publishedVerificationPassed,
        blockingFindingCount: publishedBlockingCount,
        repairCount,
        repairLimit: maxRepairs,
      });
      if (unmetBeforePublication.length > 0) {
        return await failRun(
          "COMPLETION_INVARIANT_UNMET",
          `Factoree cannot prove this change, so it published nothing. ${unmetBeforePublication.join(" ")}`,
        );
      }

      // docs/specs/autonomy-levels.md. L1 implements and checks, and returns the evidence with no
      // pull request.
      if (refined.autonomyLevel === "L1") {
        return await endReported(
          [
            "## Factoree report",
            "",
            `Status: REPORTED at L1. ${autonomyNote(refined.autonomyReasons)}`,
            "",
            "### Deterministic verification",
            "",
            publishedVerificationSummary,
            "",
            "### Independent review",
            "",
            `Verdict: ${publishedReviewVerdict}. Blocking findings: ${String(publishedBlockingCount)}.`,
            "",
            "### Change",
            "",
            publishedChangedFiles.length === 0 ? "No file changed." : publishedChangedFiles.map((file) => `- ${file}`).join("\n"),
            "",
            "Every check passed. By its level, this Run opens no pull request.",
          ].join("\n"),
        );
      }

      // docs/specs/change-sets.md, slice 7, DI-21.151. A change set publishes all or nothing. A PR
      // follow-up run keeps the one repository of its pull request until slice 9. An older history
      // ends here as DI-21.134 did: no half change reaches GitHub.
      const changeSetPublication = runTargets.length > 1 && prFollowUp === null && patched(CHANGE_SET_PUBLICATION_PATCH);
      // docs/specs/change-sets.md, slice 9, DI-21.162. A set PR follow-up run pushes a new verified
      // commit to each open pull request of the set that changed, and to no other.
      const setFollowUp = runTargets.length > 1 && prFollowUp !== null && prChangeSet !== null ? prFollowUp : null;
      if (runTargets.length > 1 && !changeSetPublication && setFollowUp === null) {
        return await failRun(
          "PUBLICATION_FAILED",
          `Every check of the change set ${runTargets.map((target) => target.fullName).join(", ")} passed, and this Factoree ` +
            "release cannot publish a change set as one step, so it opened no pull request. The last patch of each target is kept for a follow-up run.",
        );
      }

      status = "PUBLISHING";
      await activities.setRunStatus({ runId: id, status });

      // docs/specs/check-isolation.md. Publication captures from the check sprite, and the patch
      // it captures must be the patch that entered that sprite.
      const published = checkSandbox;
      if (published === null) {
        return await failRun(
          "COMPLETION_INVARIANT_UNMET",
          "Factoree has no check sandbox for this change, so it published nothing.",
        );
      }
      const publishInput = {
        runId: id,
        tenantId: input.tenantId,
        productId: input.productId,
        spriteId: published.spriteId,
        adapter: published.adapter,
        workspacePath: published.workspacePath,
        primaryPath: published.primaryPath,
        verifiedPatchSha256: published.patchSha256,
        // docs/specs/autonomy-levels.md and check-isolation.md. L2 opens a draft. So does a patch
        // that changes a file that defines a check.
        draft: publishDraft,
        repositorySlug: resolvedContext.primary.slug,
        repositoryBaseUrl: input.product.repositoryBaseUrl,
        // A PR follow-up run keeps the base branch of its pull request.
        baseBranch: prFollowUp?.baseBranch ?? defaultBranchForSlug(resolvedContext.primary.slug),
        baseSha: preparedSandbox.baseSha,
        reviewedChangedFiles: publishedChangedFiles,
        reviewedWorktreeSha: publishedWorktreeSha,
        workItemTitle: input.workItem.title,
        workItemUrl: input.workItem.url,
        verificationSummary: publishedVerificationSummary,
        repairCount,
        githubInstallationId: primaryRepositoryInstallationId,
      };

      // docs/specs/own-proposals-and-parallel-runs.md. A moved base branch no longer stops the Run.
      // The publication commits on the verified base and reports how far the branch moved.
      if (stopRequested) return await cancelRun();

      /**
       * docs/specs/change-sets.md, slice 7. The publication of a change set: the preflight of every
       * target before any push (DI-21.151), then each push and pull request in set order, then each
       * body with the sibling links (DI-21.152). A permanent failure after the preflight undoes every
       * pull request that opened (DI-21.153). A moved base never stops a target: each one publishes
       * on its verified base, and its three-way apply check reports the move.
       */
      const publishChangeSet = async (
        checked: PrepareCheckSandboxActivityOutput,
      ): Promise<{ ended: AgentRunWorkflowResult } | { published: PublishedTarget[]; unchanged: Array<{ slug: string; baseSha: string }> }> => {
        const facts = checked.checkedTargets ?? [];
        const entries = facts.map((fact) => {
          const target = runTargets.find((candidate) => candidate.fullName.toLowerCase() === fact.repository.toLowerCase());
          return {
            fact,
            repositoryId: target?.id ?? "",
            slug: target?.fullName ?? fact.repository,
            installationId: target?.githubInstallationId ?? "",
            baseBranch: defaultBranchForSlug(target?.fullName ?? fact.repository),
          };
        });
        const missing = runTargets.filter((target) => !entries.some((entry) => entry.repositoryId === target.id));
        if (missing.length > 0 || entries.some((entry) => entry.repositoryId === "")) {
          return {
            ended: await failRun(
              "COMPLETION_INVARIANT_UNMET",
              `The check sandbox holds no verified patch of ${missing.map((target) => target.fullName).join(", ") || "every target"}, so Factoree published nothing.`,
            ),
          };
        }
        let preflight: Awaited<ReturnType<typeof publishingActivities.preflightChangeSet>>;
        try {
          preflight = await publishingActivities.preflightChangeSet({
            runId: id,
            tenantId: input.tenantId,
            productId: input.productId,
            spriteId: checked.spriteId,
            adapter: checked.adapter,
            workspacePath: checked.workspacePath,
            repositoryBaseUrl: input.product.repositoryBaseUrl,
            targets: entries.map((entry) => ({
              repositorySlug: entry.slug,
              githubInstallationId: entry.installationId,
              primaryPath: entry.fact.path,
              baseBranch: entry.baseBranch,
              baseSha: entry.fact.baseSha,
              verifiedPatchSha256: entry.fact.patchSha256,
              reviewedChangedFiles: entry.fact.changedFiles,
              reviewedWorktreeSha: entry.fact.treeSha,
            })),
            verifiedSetPatchSha256: checked.patchSha256,
            reviewedSetTreeSha: publishedWorktreeSha,
          });
        } catch (error) {
          if (isCancellation(error)) throw error;
          if (stopRequested) return { ended: await cancelRun() };
          if (isConfigurationFault(error)) {
            return {
              ended: await failRun(
                "CONFIGURATION_INVALID",
                withCause(
                  "Factoree checked every repository of the change set before any push, and the GitHub App installation cannot " +
                    "mint the write credential one of them needs, so it opened no pull request. Repair the installation or its " +
                    "permissions as the cause says.",
                  error,
                ),
              ),
            };
          }
          return {
            ended: await failRun(
              publicationFailureReasonOf(error),
              withCause("Factoree checked every repository of the change set before any push, and one check failed, so it opened no pull request.", error),
            ),
          };
        }
        const changed = entries.filter((entry) => preflight.targets.some((target) => target.repositorySlug === entry.slug && target.changed));
        const unchanged = entries.filter((entry) => !changed.includes(entry)).map((entry) => ({ slug: entry.slug, baseSha: entry.fact.baseSha }));
        if (changed.length === 0) {
          return { ended: await failRun("EMPTY_PATCH", "Every check passed and no repository of the change set holds a change, so Factoree had nothing to publish.") };
        }
        const names = changed.map((entry) => entry.slug);
        // DI-21.153. The rollback looks up the run's own branch in each target, so it also finds a pull
        // request that a failed attempt opened before it could answer.
        const undo = async (failed: string, error: unknown): Promise<AgentRunWorkflowResult> => {
          const cause = causeOf(error);
          let undone: string;
          try {
            const rolled = await publishingActivities.rollbackChangeSet({
              runId: id,
              tenantId: input.tenantId,
              productId: input.productId,
              targets: changed.map((entry) => ({ repositorySlug: entry.slug, githubInstallationId: entry.installationId })),
              failedRepository: failed,
              cause: cause === "" ? "an unknown error" : cause,
            });
            undone =
              rolled.closed.length === 0
                ? "No pull request had opened."
                : `Factoree closed ${rolled.closed.map((entry) => entry.url).join(", ")} with a comment that names ${failed}, and deleted the branches.`;
          } catch (rollbackError) {
            if (isCancellation(rollbackError)) throw rollbackError;
            undone = withCause("Factoree could not close every pull request it had opened. Close them by hand.", rollbackError);
          }
          return await failRun(
            "PUBLICATION_FAILED",
            withCauseText(`The publication of ${failed} failed, so Factoree published no part of the change set ${names.join(", ")}. ${undone}`, cause),
          );
        };
        const opened: PublishedTarget[] = [];
        for (const entry of changed) {
          try {
            const publication = await publishingActivities.publish({
              runId: id,
              tenantId: input.tenantId,
              productId: input.productId,
              spriteId: checked.spriteId,
              adapter: checked.adapter,
              workspacePath: checked.workspacePath,
              primaryPath: entry.fact.path,
              verifiedPatchSha256: entry.fact.patchSha256,
              draft: publishDraft,
              repositorySlug: entry.slug,
              repositoryBaseUrl: input.product.repositoryBaseUrl,
              baseBranch: entry.baseBranch,
              baseSha: entry.fact.baseSha,
              reviewedChangedFiles: entry.fact.changedFiles,
              reviewedWorktreeSha: entry.fact.treeSha,
              workItemTitle: input.workItem.title,
              workItemUrl: input.workItem.url,
              verificationSummary: publishedVerificationSummary,
              repairCount,
              githubInstallationId: entry.installationId,
              changeSetRepositories: names,
            });
            opened.push({
              repositoryId: entry.repositoryId,
              slug: entry.slug,
              installationId: entry.installationId,
              baseBranch: entry.baseBranch,
              baseSha: entry.fact.baseSha,
              publication,
            });
          } catch (error) {
            if (isCancellation(error)) throw error;
            return { ended: await undo(entry.slug, error) };
          }
        }
        const pullRequests = opened.map((target) => ({ repository: target.slug, url: target.publication.pullRequestUrl }));
        for (const target of opened) {
          try {
            await publishingActivities.writeChangeSetBody({
              runId: id,
              tenantId: input.tenantId,
              productId: input.productId,
              repositorySlug: target.slug,
              githubInstallationId: target.installationId,
              pullRequestNumber: target.publication.pullRequestNumber,
              baseSha: target.baseSha,
              patchSha256: target.publication.patchSha256,
              changedFileCount: preflight.targets.find((entry) => entry.repositorySlug === target.slug)?.changedFiles.length ?? 0,
              workItemTitle: input.workItem.title,
              workItemUrl: input.workItem.url,
              verificationSummary: publishedVerificationSummary,
              repairCount,
              pullRequests,
              edges: runEdges,
            });
          } catch (error) {
            if (isCancellation(error)) throw error;
            return { ended: await undo(target.slug, error) };
          }
        }
        return { published: opened, unchanged };
      };

      /**
       * docs/specs/change-sets.md, slice 9, DI-21.162. The publication of a set PR follow-up run. The
       * preflight of every target runs before any push. Then each open pull request of the set takes
       * one new verified commit on its branch, with the head the run read as its parent, and a target
       * whose verified tree equals its head pushes nothing. A merged target takes no commit, so a
       * change to it fails the run. A run that changes no target fails PUBLICATION_FAILED. A push
       * cannot be undone without a force, so a later failure names the pull requests that took a
       * commit, and none of them becomes a verified head.
       */
      const publishSetFollowUp = async (
        checked: PrepareCheckSandboxActivityOutput,
        followUp: PrFollowUpInput,
      ): Promise<
        | { ended: AgentRunWorkflowResult }
        | { published: PublishedTarget[]; unchanged: Array<{ slug: string; baseSha: string }>; checkedHeads: Array<{ member: PrSetMember; baseSha: string }> }
      > => {
        const facts = checked.checkedTargets ?? [];
        const entries = facts.map((fact) => {
          const target = runTargets.find((candidate) => candidate.fullName.toLowerCase() === fact.repository.toLowerCase());
          return {
            fact,
            member: setMemberOf(fact.repository),
            repositoryId: target?.id ?? "",
            slug: target?.fullName ?? fact.repository,
            installationId: target?.githubInstallationId ?? "",
          };
        });
        const missing = runTargets.filter((target) => !entries.some((entry) => entry.repositoryId === target.id));
        if (missing.length > 0 || entries.some((entry) => entry.repositoryId === "" || entry.member === null)) {
          return {
            ended: await failRun(
              "COMPLETION_INVARIANT_UNMET",
              `The check sandbox holds no verified patch of ${missing.map((target) => target.fullName).join(", ") || "every pull request of the change set"}, so Factoree pushed nothing.`,
            ),
          };
        }
        let preflight: Awaited<ReturnType<typeof publishingActivities.preflightChangeSet>>;
        try {
          preflight = await publishingActivities.preflightChangeSet({
            runId: id,
            tenantId: input.tenantId,
            productId: input.productId,
            spriteId: checked.spriteId,
            adapter: checked.adapter,
            workspacePath: checked.workspacePath,
            repositoryBaseUrl: input.product.repositoryBaseUrl,
            targets: entries.map((entry) => ({
              repositorySlug: entry.slug,
              githubInstallationId: entry.installationId,
              primaryPath: entry.fact.path,
              baseBranch: entry.member?.baseBranch ?? defaultBranchForSlug(entry.slug),
              baseSha: entry.fact.baseSha,
              verifiedPatchSha256: entry.fact.patchSha256,
              reviewedChangedFiles: entry.fact.changedFiles,
              reviewedWorktreeSha: entry.fact.treeSha,
            })),
            verifiedSetPatchSha256: checked.patchSha256,
            reviewedSetTreeSha: publishedWorktreeSha,
          });
        } catch (error) {
          if (isCancellation(error)) throw error;
          if (stopRequested) return { ended: await cancelRun() };
          if (isConfigurationFault(error)) {
            return {
              ended: await failRun(
                "CONFIGURATION_INVALID",
                withCause(
                  "Factoree checked every pull request of the change set before any push, and the GitHub App installation cannot " +
                    "mint the write credential one of them needs, so it pushed nothing. Repair the installation or its permissions as the cause says.",
                  error,
                ),
              ),
            };
          }
          return {
            ended: await failRun(
              publicationFailureReasonOf(error),
              withCause("Factoree checked every pull request of the change set before any push, and one check failed, so it pushed nothing.", error),
            ),
          };
        }
        const changedMerged = entries.filter(
          (entry) => entry.member?.state === "merged" && preflight.targets.some((target) => target.repositorySlug === entry.slug && target.changed),
        );
        if (changedMerged.length > 0) {
          return {
            ended: await failRun(
              "PUBLICATION_FAILED",
              `The change touches ${changedMerged.map((entry) => `${entry.slug} (${entry.member?.url ?? ""})`).join(", ")}, whose pull request merged already. ` +
                "A merged pull request takes no new commit, so Factoree pushed nothing. A change to it needs a new issue.",
            ),
          };
        }
        const published: PublishedTarget[] = [];
        const unchanged: Array<{ slug: string; baseSha: string }> = [];
        const checkedHeads: Array<{ member: PrSetMember; baseSha: string }> = [];
        for (const entry of entries) {
          const member = entry.member;
          if (member === null) continue;
          if (member.state === "merged") {
            unchanged.push({ slug: entry.slug, baseSha: entry.fact.baseSha });
            continue;
          }
          const merges = followUp.baseUpdate !== undefined && member.pullRequestId === followUp.pullRequestId;
          try {
            const pushed = await publishingActivities.publishFollowUp({
              ...publishInput,
              spriteId: checked.spriteId,
              adapter: checked.adapter,
              workspacePath: checked.workspacePath,
              primaryPath: entry.fact.path,
              verifiedPatchSha256: entry.fact.patchSha256,
              repositorySlug: entry.slug,
              baseBranch: member.baseBranch,
              baseSha: entry.fact.baseSha,
              reviewedChangedFiles: entry.fact.changedFiles,
              reviewedWorktreeSha: entry.fact.treeSha,
              githubInstallationId: entry.installationId,
              branch: member.headBranch,
              parentSha: member.headSha,
              // Slice 4, DI-21.119. The commit merges the new base into the branch it brings current.
              ...(merges ? { mergeParentSha: member.baseSha } : {}),
              pullRequestUrl: member.url,
              pullRequestNumber: member.number,
              contractRevision: member.contractRevision + 1,
              allowUnchanged: true,
            });
            if (pushed.unchanged === true) {
              unchanged.push({ slug: entry.slug, baseSha: entry.fact.baseSha });
              checkedHeads.push({ member, baseSha: entry.fact.baseSha });
              continue;
            }
            published.push({
              repositoryId: entry.repositoryId,
              slug: entry.slug,
              installationId: entry.installationId,
              baseBranch: member.baseBranch,
              baseSha: entry.fact.baseSha,
              publication: { ...pushed, pullRequestUrl: member.url, pullRequestNumber: member.number, branch: member.headBranch, created: false },
            });
          } catch (error) {
            if (isCancellation(error)) throw error;
            const pushedLine =
              published.length === 0
                ? "No pull request of the set took a commit."
                : `${published.map((target) => target.publication.pullRequestUrl).join(", ")} took a new commit that no verified head records, so its merge-order status turns to failure until a new set run.`;
            return {
              ended: await failRun(
                isConfigurationFault(error) ? "CONFIGURATION_INVALID" : publicationFailureReasonOf(error),
                withCause(`The push to ${member.url} failed. ${pushedLine}`, error),
              ),
            };
          }
        }
        if (published.length === 0) {
          return {
            ended: await failRun(
              "PUBLICATION_FAILED",
              `Every check passed and the run changed no pull request of the change set ${prChangeSet?.members.map((member) => member.url).join(", ") ?? ""}, so Factoree pushed nothing.`,
            ),
          };
        }
        return { published, unchanged, checkedHeads };
      };

      let publication: PublishActivityOutput;
      let publishedTargets: PublishedTarget[];
      let unchangedTargets: Array<{ slug: string; baseSha: string }> = [];
      // DI-21.162. The open pull requests of a set PR follow-up run that it checked and changed nothing on.
      let checkedSetHeads: Array<{ member: PrSetMember; baseSha: string }> = [];
      if (changeSetPublication) {
        const set = await publishChangeSet(published);
        if ("ended" in set) return set.ended;
        publishedTargets = set.published;
        unchangedTargets = set.unchanged;
        const first = publishedTargets[0];
        if (first === undefined) throw ApplicationFailure.nonRetryable("the change set publication opened no pull request");
        publication = first.publication;
      } else if (setFollowUp !== null) {
        const set = await publishSetFollowUp(published, setFollowUp);
        if ("ended" in set) return set.ended;
        publishedTargets = set.published;
        unchangedTargets = set.unchanged;
        checkedSetHeads = set.checkedHeads;
        const first = publishedTargets[0];
        if (first === undefined) throw ApplicationFailure.nonRetryable("the set PR follow-up run pushed to no pull request");
        publication = first.publication;
      } else {
      try {
        if (prFollowUp === null) {
          publication = await publishingActivities.publish(publishInput);
        } else {
          // D2. One new verified commit on the branch of the pull request, with the head this run read
          // as its parent. No new pull request opens, and the push never forces.
          const pushed = await publishingActivities.publishFollowUp({
            ...publishInput,
            branch: prFollowUp.headBranch,
            parentSha: prFollowUp.headSha,
            // Slice 4, DI-21.119. The commit merges the new base into the branch.
            ...(prFollowUp.baseUpdate === undefined ? {} : { mergeParentSha: prFollowUp.baseSha }),
            pullRequestUrl: prFollowUp.url,
            pullRequestNumber: prFollowUp.number,
            contractRevision: prFollowUp.contractRevision,
          });
          publication = {
            ...pushed,
            pullRequestUrl: prFollowUp.url,
            pullRequestNumber: prFollowUp.number,
            branch: prFollowUp.headBranch,
            created: false,
          };
        }
      } catch (error) {
        if (isCancellation(error)) throw error;
        // SDD section 50. A human stop is never a configuration fault. It is never a publication
        // failure either, because this path published nothing.
        if (stopRequested) return await cancelRun();
        if (isConfigurationFault(error)) {
          return await failRun(
            "CONFIGURATION_INVALID",
            withCause(
              "Factoree could not publish, because the GitHub App installation cannot mint the write " +
                "credential this change needs. Repair the installation or its permissions as the " +
                "cause says. No agent session ever receives that credential.",
              error,
            ),
          );
        }
        const reason = publicationFailureReasonOf(error);
        return await failRun(
          reason,
          reason === "PATCH_HASH_MISMATCH"
            ? "The patch of the trusted checkout did not equal the verified patch, so Factoree " +
                "published nothing. SDD section 46 blocks publication on a hash mismatch."
            : reason === "EMPTY_PATCH"
              ? "Every check passed and the change holds no file, so Factoree had nothing to " +
                  "publish."
              : withCause(
                  "Factoree could not publish the verified change. Factoree created no pull request " +
                    "for it.",
                  error,
                ),
        );
      }
      publishedTargets = [
        {
          repositoryId: primaryRepositoryId,
          slug: resolvedContext.primary.slug,
          installationId: primaryRepositoryInstallationId,
          baseBranch: publishInput.baseBranch,
          baseSha: publishInput.baseSha,
          publication,
        },
      ];
      }
      const publishedUrls = publishedTargets.map((target) => target.publication.pullRequestUrl);

      await notify(() =>
        activities.postProgress({
          sessionId: input.agentSessionId,
          message:
            changeSetPublication
              ? `Factoree opened the pull requests of the change set: ${publishedTargets.map((target) => `${target.slug} ${target.publication.pullRequestUrl}`).join(", ")}.`
              : setFollowUp !== null
              ? `Factoree pushed a verified commit to ${publishedTargets
                  .map((target) => `${target.publication.pullRequestUrl} (${target.publication.commitSha.slice(0, 12)})`)
                  .join(", ")} (contract revision ${String(setFollowUp.contractRevision)}).` +
                (unchangedTargets.length === 0 ? "" : ` It changed nothing on ${unchangedTargets.map((target) => target.slug).join(", ")}.`)
              : prFollowUp === null
              ? `Factoree opened the pull request: ${publication.pullRequestUrl}.`
              : `Factoree pushed the verified commit ${publication.commitSha.slice(0, 12)} to the pull request ${publication.pullRequestUrl} ` +
                `(contract revision ${String(prFollowUp.contractRevision)}).`,
        }),
      );

      // The publication succeeded. A later stop message and a later timeout message read this
      // value, so neither one claims that Factoree published nothing.
      publishedPullRequestUrls.push(...publishedUrls);

      // DI-21.52. The issue shows its pull request as an attachment, and the session as a link.
      // A PR follow-up run shares the agent session of the run that linked the pull request.
      // docs/specs/change-sets.md: one attachment and one session link per pull request of a set.
      let pullRequestLinked = prFollowUp !== null;
      if (prFollowUp === null && patched(PULL_REQUEST_LINK_PATCH)) {
        let linked = 0;
        for (const target of publishedTargets) {
          const linkedUrl = target.publication.pullRequestUrl;
          await notify(async () => {
            await activities.linkPullRequest({
              tenantId: input.tenantId,
              sessionId: input.agentSessionId,
              issueId: input.workItem.issueId,
              pullRequestUrl: linkedUrl,
              repositorySlug: target.slug,
              ...(changeSetPublication ? { label: `Pull request ${target.slug}` } : {}),
            });
            linked += 1;
          });
        }
        pullRequestLinked = linked === publishedTargets.length;
      }

      // Specification section 14. The patch hash and commit SHA are known after publication, and
      // the pull request URL is known once the pull request exists. All three describe the same
      // moment here.
      for (const target of publishedTargets) {
        await activities.recordRunTargetFacts({
          tenantId: input.tenantId,
          runId: id,
          repositoryId: target.repositoryId,
          patchSha256: target.publication.patchSha256,
          commitSha: target.publication.commitSha,
          pullRequestUrl: target.publication.pullRequestUrl,
        });
      }

      // docs/specs/pr-review-merge-and-deploy.md, D3. The pull request record names this run as its
      // origin, and the PR workflow takes the events after the run ends. ABANDON keeps that workflow
      // open after this run closes. A failure here costs only the PR workflow: the close then takes
      // the webhook path of DI-21.51.
      // docs/specs/change-sets.md: one record and one PR workflow per pull request of a set.
      // docs/specs/change-sets.md, slice 9, DI-21.162. Each pull request of a set PR follow-up run that took
      // a commit records it as its verified head, with its own base and contract revision. Each open one it
      // checked and changed nothing on records its head as checked. The PR workflows already run.
      if (setFollowUp !== null) {
        const level = publishDraft ? "L2" : refined.autonomyLevel;
        for (const target of publishedTargets) {
          const member = setMemberOf(target.slug);
          if (member === null) continue;
          await notify(async () => {
            await activities.recordPullRequest({
              tenantId: input.tenantId,
              runId: id,
              repositoryId: target.repositoryId,
              number: member.number,
              url: member.url,
              headBranch: member.headBranch,
              headSha: target.publication.commitSha,
              baseBranch: member.baseBranch,
              autonomyLevel: level,
              baseSha: target.baseSha,
              contractRevision: member.contractRevision + 1,
            });
          });
        }
        for (const checkedHead of checkedSetHeads) {
          await notify(async () => {
            await activities.recordCheckedHead({
              tenantId: input.tenantId,
              pullRequestId: checkedHead.member.pullRequestId,
              headSha: checkedHead.member.headSha,
              baseSha: checkedHead.baseSha,
              runId: id,
              autonomyLevel: level,
            });
          });
        }
      }
      for (const target of setFollowUp === null ? publishedTargets : []) {
      if (patched(PR_WORKFLOW_PATCH)) {
        const recordInput = {
          tenantId: input.tenantId,
          runId: id,
          repositoryId: target.repositoryId,
          number: target.publication.pullRequestNumber,
          url: target.publication.pullRequestUrl,
          headBranch: target.publication.branch,
          headSha: target.publication.commitSha,
          baseBranch: target.baseBranch,
          // DI-21.104. The PR workflow turns on auto-merge only for the head of an L4 run. DI-21.112: a
          // PR follow-up commit that a first run would publish as a draft lands on the open pull
          // request, so its head records L2, and auto-merge stays off for it.
          autonomyLevel: prFollowUp !== null && publishDraft ? "L2" : refined.autonomyLevel,
          // D2. The next PR follow-up run starts from this base.
          baseSha: target.baseSha,
          ...(prFollowUp === null ? {} : { contractRevision: prFollowUp.contractRevision }),
        };
        await notify(async () => {
          const recorded = await activities.recordPullRequest(recordInput);
          // A PR follow-up run runs under the PR workflow of its pull request, which already runs.
          if (prFollowUp !== null) return;
          try {
            await startChild(pullRequestWorkflow, {
              workflowId: recorded.workflowId,
              args: [{ tenantId: input.tenantId, pullRequestId: recorded.pullRequestId }],
              parentClosePolicy: ParentClosePolicy.ABANDON,
            });
          } catch (error) {
            // A webhook event already started it with signal-with-start.
            if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
          }
        });
      }
      }

      // docs/specs/change-sets.md, slice 8, DI-21.155. Each consumer pull request of the set gets its
      // `factoree/change-set` status: pending while a provider pull request is open. A set with no
      // safe order gets none. A failure costs only the status, and the next event of the set sets it.
      if (changeSetPublication && patched(CHANGE_SET_STATUS_PATCH)) {
        await notify(async () => {
          await activities.setChangeSetStatuses({ tenantId: input.tenantId, originRunId: id });
        });
      }
      // docs/specs/change-sets.md, slice 9. A set PR follow-up run sets each consumer status again from
      // the new heads.
      if (setFollowUp !== null) {
        await notify(async () => {
          await activities.setChangeSetStatuses({ tenantId: input.tenantId, pullRequestId: setFollowUp.pullRequestId });
        });
      }

      // SDD section 50. A stop that arrived during the publication ends the Run CANCELLED. The
      // pull request already exists, and the stop message names it.
      if (stopRequested) return await cancelRun();

      // SDD section 47. One Proof Pack, built from persisted state, posted as the Linear final
      // response. SDD section 68 forbids READY_FOR_HUMAN without it.
      // docs/specs/skill-registry.md. The proof pack lists the skill proposal, so it leaves first.
      const proposalSources = skillSources;
      if (proposalSources !== null && patched(SKILL_REGISTRY_PATCH)) {
        await notify(() => sendSkillProposals(proposalSources, preparedSandbox));
        skillProposalsSent = true;
      }

      let proofPack: PublishProofPackActivityOutput;
      try {
        proofPack = await proofPackActivities.publishProofPack({
          waitedMs,
          runId: id,
          tenantId: input.tenantId,
          productId: input.productId,
          sessionId: input.agentSessionId,
          workItem: { title: input.workItem.title, url: input.workItem.url },
          pullRequestUrl: publication.pullRequestUrl,
          pullRequestLinked,
          commitSha: publication.commitSha,
          // DI-21.154. A change set names its set patch hash and the base of its first target.
          patchSha256: changeSetPublication || setFollowUp !== null ? published.patchSha256 : publication.patchSha256,
          baseSha: changeSetPublication || setFollowUp !== null ? (publishedTargets[0]?.baseSha ?? publishInput.baseSha) : publishInput.baseSha,
          changedFiles: publishedChangedFiles,
          patchByteLength: publishedTargets.reduce((total, target) => total + target.publication.patchByteLength, 0),
          previewUrl: publishedPreviewUrl,
          fakes: publishedFakes,
          ...(publishedSetCheckNotes.length === 0 ? {} : { setCheckNotes: publishedSetCheckNotes }),
          repairCount,
          repairLimit: maxRepairs,
          reviewVerdict: publishedReviewVerdict,
          reviewPasses: publishedReviewPasses,
          reviewAttempt: publishedReviewAttempt,
          changeDescription: publishedChangeDescription,
          visualEvidenceGap,
          ...(forYourEye.length === 0 ? {} : { forYourEye }),
          decisions: factoreeDecisions,
          baseMove:
            changeSetPublication || setFollowUp !== null || publication.baseMove === null
              ? null
              : { baseBranch: publishInput.baseBranch, ...publication.baseMove },
          ...(changeSetPublication || setFollowUp !== null
            ? {
                targetResults: (published.checkedTargets ?? []).map((fact) => {
                  const target = publishedTargets.find((candidate) => candidate.slug.toLowerCase() === fact.repository.toLowerCase());
                  const unchanged = unchangedTargets.find((candidate) => candidate.slug.toLowerCase() === fact.repository.toLowerCase());
                  return target === undefined
                    ? { repository: unchanged?.slug ?? fact.repository, baseSha: fact.baseSha, result: "unchanged" as const, pullRequestUrl: null, baseMove: null }
                    : {
                        repository: target.slug,
                        baseSha: target.baseSha,
                        result: "published" as const,
                        pullRequestUrl: target.publication.pullRequestUrl,
                        baseMove: target.publication.baseMove === null ? null : { baseBranch: target.baseBranch, ...target.publication.baseMove },
                      };
                }),
              }
            : {}),
          autonomyLevel: refined.autonomyLevel,
          autonomyReasons: refined.autonomyReasons,
          checkDefiningFiles: published.checkDefiningFiles,
          // docs/specs/pr-review-merge-and-deploy.md. The proof pack names the contract revision of the head commit.
          ...(prFollowUp === null
            ? {}
            : {
                pullRequestFollowUp: {
                  contractRevision: prFollowUp.contractRevision,
                  trigger: prFollowUp.trigger,
                  startedBy:
                    prFollowUp.trigger === "base"
                      ? prFollowUp.baseBranch
                      : prFollowUp.trigger === "human"
                      ? (prFollowUp.reviewerLogin ?? "A human")
                      : prFollowUp.reviewer === null
                        ? "PR reviewer"
                        : `${prFollowUp.reviewer.appSlug} (${prFollowUp.reviewer.checkName})`,
                  kept: triagedFindings
                    .filter((finding) => finding.kept)
                    .map((finding) => ({ evidence: finding.evidence, defect: finding.defect, rule: finding.rule })),
                  dropped: triagedFindings.filter((finding) => !finding.kept).length,
                  plainComments: prFollowUp.plainComments,
                },
              }),
        });
      } catch (error) {
        if (isCancellation(error)) throw error;
        if (stopRequested) return await cancelRun();
        // SDD section 68. The change is published, and Factoree cannot prove it to a human. It
        // must never report a success it cannot prove, so the Run fails and names the pull
        // request a human must now read by hand.
        return await failRun(
          "COMPLETION_INVARIANT_UNMET",
          "Factoree published the verified change and could not post the Proof Pack. Review the " +
            `pull request by hand. ${publishedUrls.length === 1 ? "Pull request" : "Pull requests"}: ${publishedUrls.join(", ")}.`,
        );
      }

      if (stopRequested) return await cancelRun();

      // SDD section 68. Every clause is checked from recorded facts, immediately before the one
      // state that claims success. No agent claim reaches this check.
      const unmet = completionInvariantFailures({
        workItemReady: refined.status === "ready",
        contextContractVersion,
        unresolvedConflict: resolvedContext.unresolvedConflict !== null,
        validationContractVersion,
        validationContractFrozenAt: validation.frozenAt,
        implementationStartedAt,
        validationPassed: publishedValidationPassed,
        validationUnstableOnly: publishedValidationUnstableOnly,
        draft: publishDraft,
        verificationPassed: publishedVerificationPassed,
        blockingFindingCount: publishedBlockingCount,
        repairCount,
        repairLimit: maxRepairs,
        // docs/specs/change-sets.md. One verified patch and one pull request per target of the run.
        // docs/specs/change-sets.md, DI-21.154. A target whose patch changes no file opens no pull request.
        targets: publishedTargets.map((target) => ({
          repositoryFullName: changeSetPublication || setFollowUp !== null ? target.slug : primaryRepositorySlug,
          patchSha256: target.publication.patchSha256,
          pullRequestUrl: target.publication.pullRequestUrl,
        })),
        proofPackSha256: proofPack.sha256,
      });

      if (unmet.length > 0) {
        return await failRun(
          "COMPLETION_INVARIANT_UNMET",
          "Factoree published the verified change and cannot report it complete. " +
            `${unmet.join(" ")} ${publishedUrls.length === 1 ? "Pull request" : "Pull requests"}: ${publishedUrls.join(", ")}.`,
        );
      }

      // SDD section 48. The Run is complete. This is the one success terminal state, and the
      // completion invariant above is the only gate that reaches it.
      status = "READY_FOR_HUMAN";
      await completeRun({
        tenantId: input.tenantId,
        runId: id,
        status,
        completedAt: new Date(Date.now()).toISOString(),
      });
      return { runId: id, status };
    }

    // Every path of the block above reaches a terminal state of SDD section 48. Phase 9 kept a
    // residual wait here, because no success terminal state existed yet. The Proof Pack of
    // SDD section 47 now completes a proved Run, so that wait is gone.
  } catch (error) {
    // Any unhandled activity failure must still drive the Run to a terminal state.
    status = "FAILED";
    // docs/specs/run-failure-detail.md. The row and the agent session keep the cause.
    const message = withCause(INTERNAL_ERROR_SENTENCE, error);
    await completeRun({
      tenantId: input.tenantId,
      runId: id,
      status,
      failureReason: "INTERNAL_ERROR",
      failureMessage: message,
      completedAt: new Date(Date.now()).toISOString(),
    });
    if (patched(INTERNAL_ERROR_POST_PATCH)) {
      // A cancelled scope still posts, as the terminal write above still runs.
      await CancellationScope.nonCancellable(async () => {
        let post = message;
        try {
          post = await activities.describeRunFailure({ tenantId: input.tenantId, runId: id, message });
        } catch {
          // The post falls back to the message when the facts cannot be read.
        }
        await notify(() => activities.postError({ sessionId: input.agentSessionId, message: post }));
        if (prFollowUp === null && patched(DRAFT_OFFER_PATCH)) {
          await notify(() => activities.offerDraft({ tenantId: input.tenantId, runId: id, sessionId: input.agentSessionId }));
        }
      });
    }
    // A plain error fails the workflow task, and Temporal retries that task for ever while the
    // row says FAILED. A Temporal failure ends the workflow.
    if (error instanceof TemporalFailure) throw error;
    throw ApplicationFailure.fromError(error, { nonRetryable: true });
  }
}

/** One sentence that names the level rules that applied, or none. */
const autonomyNote = (reasons: string[]): string =>
  reasons.length === 0 ? "The Product default level applies." : reasons.join(" ");

// A Linear notification failure must not abort the workflow after the durable state is written.
const notify = async (send: () => Promise<void>): Promise<void> => {
  try {
    await send();
  } catch {
    // The Run is already terminal in the database. The Linear post is best effort.
  }
};
