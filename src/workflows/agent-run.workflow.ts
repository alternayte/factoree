import {
  ActivityCancellationType,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  ApplicationFailure,
  isCancellation,
  patched,
  TemporalFailure,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import type { RunStatus } from "~/domain/runs/run-status.js";
import type { Activities } from "~/activities/index.js";
import type {
  PrepareCheckSandboxActivityOutput,
  PrepareSandboxActivityOutput,
} from "~/activities/sandbox.activities.js";
import type { ImplementActivityOutput } from "~/activities/agent.activities.js";
import type { ProposeRefinementActivityOutput } from "~/activities/refinement.activities.js";
import type { VerifyActivityOutput } from "~/activities/verification.activities.js";
import type { UserValidateActivityOutput } from "~/activities/validation.activities.js";
import type { ReviewActivityOutput } from "~/activities/review.activities.js";
import type { ResolveContextActivityOutput } from "~/activities/context.activities.js";
import type {
  PublishActivityOutput,
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
import { SANDBOX_SLOT_UNAVAILABLE_TYPE } from "../domain/runs/sandbox-slot-error.js";
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
import { proposeTarget, selectTarget } from "../domain/routing/select-targets.js";
import { describeDecision, type FactoreeDecision } from "../domain/runs/factoree-decision.js";
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
}

export interface AgentRunWorkflowResult {
  runId: string;
  status: RunStatus;
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
/** docs/specs/run-failure-detail.md. An internal error posts its cause to the agent session. */
const INTERNAL_ERROR_POST_PATCH = "internal-error-post";

/** docs/specs/skill-registry.md. Skill proposals and the run outcome reach the skill sources. */
const SKILL_REGISTRY_PATCH = "skill-registry-signals";

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

export const stopSignal = defineSignal("stop");
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
      nonRetryableErrorTypes: [RUN_CONFIGURATION_ERROR_TYPE, SANDBOX_SLOT_UNAVAILABLE_TYPE],
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

// The cancellation of a live Implementer session runs after the Run budget has ended, so it
// needs its own short timeout.
const cancelActivities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3, initialInterval: "1 second", backoffCoefficient: 2 },
});

// The first Implementer attempt of a Run. A later repair loop attempt increments this value, so
// each attempt writes its own AgentExecution row.
const FIRST_IMPLEMENTER_ATTEMPT = 1;

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
  let sprite: PrepareSandboxActivityOutput | null = null;
  // docs/specs/check-isolation.md. The check sprite of the current attempt. Verification, user
  // validation, review and publication run there, never in the sprite the Implementer used.
  let checkSandbox: PrepareCheckSandboxActivityOutput | null = null;
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
  let questionRounds = 0;

  // Refinement needs a repository pair before target selection runs, further below. This
  // placeholder feeds Refinement only, and the pass-through echo never reaches the sandbox. The
  // target-selection step corrects `primaryRepositorySlug` once the target is known.
  const targetRepositories = input.product.repositories;
  let primaryRepositorySlug = targetRepositories[0]?.fullName ?? "";
  // Specification section 5. The id of the confirmed target's RunTarget row, so the later steps
  // can record its per-target facts as they become known.
  let primaryRepositoryId = targetRepositories[0]?.id ?? "";
  // The GitHub App installation that grants the target repository. The clone, the discovery
  // read, and the publish all mint against this id, never against a Project secret.
  let primaryRepositoryInstallationId = targetRepositories[0]?.githubInstallationId ?? "";
  // Specification section 12. A repository in the Product that is not the target is absent at
  // start. It must reach an agent only through clone_sibling, which the Action Policy gates and
  // which writes an evidence record. This list must therefore never take a value from Product
  // membership. `Project.referenceRepositories` no longer exists (specification section 5,
  // "Removed"); a legitimate reference repository now arrives as an ordinary context source
  // (for example Backstage), a mechanism this list plays no part in.
  const referenceRepositorySlugs: string[] = [];
  const defaultBranchForSlug = (slug: string) =>
    targetRepositories.find((repository) => repository.fullName === slug)?.defaultBranch ?? "main";

  setHandler(stopSignal, () => {
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
  // A const holds the identifier, because narrowing of a let does not survive into a closure.
  const id = created.runId;

  // The Run budget starts here. Every later step reads the remaining time from this deadline, so
  // preparation and implementation consume the same budget as the wait does.
  // `maxRunMinutes` can be a fraction. A whole number of milliseconds, with a floor of one
  // second, keeps every derived Temporal duration valid.
  const runBudgetMs = Math.max(1_000, Math.round(input.maxRunMinutes * 60_000));
  // DI-15.13. A wait in QUEUED is not work, so the deadline moves by the time the Run waited there.
  let deadline = Date.now() + runBudgetMs;
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
      await activities.completeRun(args);
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
    if ((status === "FAILED" || status === "FAILED_REVIEW") && patched(FAILURE_POST_PATCH)) {
      try {
        post = await activities.describeRunFailure({ tenantId: input.tenantId, runId: id, message });
      } catch (error) {
        if (isCancellation(error)) throw error;
      }
    }
    await notify(() => activities.postError({ sessionId: input.agentSessionId, message: post }));
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
  ): Promise<AgentRunWorkflowResult> =>
    await failRun(
      "AGENT_HUNG",
      `The ${describeAgentRole(role)} session wrote no output for ${describeSilenceLimit(hang.silenceLimitMs)} ` +
        `${reason}, so Factoree stopped it and ended the Run. Factoree published nothing.`,
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
   * The pull request URL of a successful publication, or null while nothing is published. A stop
   * message and a timeout message must not claim that nothing was published once it exists. The
   * Run status does not change, because SDD section 68 forbids a success terminal state before
   * Phase 10 builds the Proof Pack.
   */
  let publishedPullRequestUrl: string | null = null;

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
        referencePaths: attemptInput.prepared.referencePaths,
        goal: attemptInput.goal,
        contextContract: attemptInput.contextContract,
        validationContract: attemptInput.validationContract,
        requiredContext: attemptInput.requiredContext,
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
        services: attemptInput.prepared.runtime.services ?? null,
        ...(attemptInput.afterHang === true ? { afterHang: true } : {}),
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
        goal: attemptInput.goal,
        contextContract: attemptInput.contextContract,
        constraints: attemptInput.constraints,
        verificationSummary: attemptInput.verificationSummary,
        ...(attemptInput.validationEvidence === undefined ? {} : { validationEvidence: attemptInput.validationEvidence }),
        repositoryInstructions: attemptInput.prepared.repositoryInstructions,
        timeoutMs: budgetMs,
        attempt: attemptInput.attempt,
        ...(attemptInput.afterHang === true ? { afterHang: true } : {}),
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
        body:
          publishedPullRequestUrl === null
            ? "Factoree stopped this Run at your request. No change was published."
            : "Factoree stopped this Run at your request. The verified change is already " +
              `published and waits for a human. Pull request: ${publishedPullRequestUrl}.`,
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
    if (queuedSince !== null) deadline += Date.now() - queuedSince;
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
              "The sandbox provider runs its limit of live sandboxes, and none of them is retained " +
              "for inspection. Factoree waits for a free sandbox.",
          }),
        );
      }
      if (await condition(() => stopRequested, Math.max(1, Math.min(SANDBOX_SLOT_POLL_MS, remainingMs())))) return null;
    }
  };

  try {
    await activities.acknowledgeSession({
      sessionId: input.agentSessionId,
      message: "Factoree accepted the work and started a Run.",
    });

    status = "RECEIVED";
    await activities.setRunStatus({ runId: id, status, startedAt: new Date(Date.now()).toISOString() });

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

      // SDD section 8. Refinement reads the Work Item and the Project record only. It reaches no
      // repository and no sandbox, so it runs before preparation.
      const refinementInput = () => ({
        runId: id,
        tenantId: input.tenantId,
        productId: input.productId,
        source: { ...input.workItem, labels },
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

      // docs/specs/own-proposals-and-parallel-runs.md. The issue text or the Linear project decides
      // the target when exactly one repository matches. A pick among equals is a guess, so only
      // then does a human choose.
      let targetOutcome = selectTarget(
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

      // SDD section 20. Discovery pins one SHA for each repository. The ref below is the ref
      // discovery starts from. The checkout later uses the pinned SHA.
      const repositoryRef = (slug: string) => ({
        slug,
        url: buildRepositoryUrl(input.product.repositoryBaseUrl, slug),
        ref: defaultBranchForSlug(slug),
      });

      // SDD section 23. A conflict without an authority winner blocks the Run. The bounded
      // rounds end this loop, and the Run budget ends it as well.
      let resolvedContext: ResolveContextActivityOutput;
      for (;;) {
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "RESOLVING_CONTEXT";
        await activities.setRunStatus({ runId: id, status });

        try {
          resolvedContext = await buildContextActivities(remainingMs()).resolveContext({
            runId: id,
            tenantId: input.tenantId,
            productId: input.productId,
            goal: refined.goal,
            acceptanceCriteria: refined.acceptanceCriteria,
            primaryRepository: repositoryRef(refined.primaryRepository),
            referenceRepositories: refined.referenceRepositories.map(repositoryRef),
            workItemReferences: refined.workItemReferences,
            decisions,
            githubInstallationId: primaryRepositoryInstallationId,
          });
        } catch (error) {
          // SDD section 49. A repository reference that resolves to nothing is a semantic
          // failure, so it drives a workflow decision. The retry policy already denied a second
          // attempt. A transport fault is not this type, so it still retries.
          if (isConfigurationFault(error)) {
            return await failRun(
              "CONFIGURATION_INVALID",
              withCause(
                "Factoree could not resolve the context, because the Run configuration is invalid. " +
                  "Repair the repository reference, the reference repositories, or the default branch.",
                error,
              ),
            );
          }
          throw error;
        }
        // SDD section 21. Only a frozen Context Contract has a version. A resolution that still
        // holds an unresolved conflict stored nothing, so the snapshot reports no version.
        contextContractVersion =
          resolvedContext.unresolvedConflict === null ? resolvedContext.sha256 : null;

        await notify(() =>
          activities.postProgress({
            sessionId: input.agentSessionId,
            message: resolvedContext.summary,
          }),
        );

        const conflict = resolvedContext.unresolvedConflict;
        if (conflict === null) break;

        // SDD section 23. No safe resolution exists, so implementation must not start.
        const proceeded = await askAndWait(
          conflict.id,
          conflict.question,
          conflict.subject,
          conflict.domain,
        );
        if (stopRequested) return await cancelRun();
        if (!proceeded) {
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          return await failRun(
            "CONTEXT_UNRESOLVED",
            "Factoree could not start, because two equally authoritative sources disagree: " +
              `${conflict.question} Factoree published nothing.`,
          );
        }
      }

      // A stop that arrived during the context work must prevent preparation.
      if (stopRequested) return await cancelRun();
      if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

      // Specification section 8. The routing table used a cached repository row. The base
      // commit is the ground truth. Factoree reads the identity block there. It checks that
      // block against the Product routing used.
      const identity = await activities.verifyTargetIdentity({
        runId: id,
        tenantId: input.tenantId,
        productId: input.productId,
        productSlug: input.product.productSlug,
        repositoryUrl: buildRepositoryUrl(input.product.repositoryBaseUrl, resolvedContext.primary.slug),
        baseSha: resolvedContext.primary.sha,
        githubInstallationId: primaryRepositoryInstallationId,
      });
      if (stopRequested) return await cancelRun();
      if (!identity.matched) {
        return await endRoutingMismatch(
          input.product.productSlug,
          identity.declaredProduct ?? "an unknown Product",
        );
      }

      // Specification section 14. The base SHA of the target's RunTarget row is known now, at
      // context resolution.
      await activities.recordRunTargetFacts({
        tenantId: input.tenantId,
        runId: id,
        repositoryId: primaryRepositoryId,
        baseSha: resolvedContext.primary.sha,
      });

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
      const prepareInput = {
        runId: id,
        tenantId: input.tenantId,
        productId: input.productId,
        primary: sandbox.primary,
        references: sandbox.references,
        defaults: sandbox.defaults,
        environment: {},
        organizationSkills: sandbox.organizationSkills,
        githubInstallationId: primaryRepositoryInstallationId,
        skillRegistry: input.product.skillRegistry ?? null,
      };

      // SDD section 32. The sandbox stays after the Run ends. `SpriteReaper` deletes it once the
      // retention window of SDD section 51 has passed.
      // A const holds the prepared sandbox, because narrowing of a let does not survive into a
      // closure.
      let preparedSandbox: PrepareSandboxActivityOutput;
      try {
        const work = await withSandboxSlot((budgetMs) => buildSandboxActivities(budgetMs).prepareSandbox(prepareInput));
        if (work === null) {
          if (stopRequested) return await cancelRun();
          return await failRun("RUN_TIMEOUT", timeoutMessage);
        }
        preparedSandbox = work;
      } catch (error) {
        // A configuration fault is not an infrastructure fault. The Run ends in
        // `FAILED_CONFIGURATION`, and the retry policy already denied a second attempt.
        if (isConfigurationFault(error)) {
          return await failRun(
            "CONFIGURATION_INVALID",
            withCause(
              "Factoree could not prepare the sandbox, because the Run configuration is invalid. " +
                "Repair the repository reference, the reference repositories, or the bootstrap command.",
              error,
            ),
          );
        }
        // Preparation is bounded by the remaining budget. A budget that ran out during
        // preparation is a Run timeout, not an internal fault.
        if (remainingMs() > 0) throw error;
        return await failRun("RUN_TIMEOUT", timeoutMessage);
      }
      sprite = preparedSandbox;
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
      const proposeOnce = (afterHang: boolean): Promise<ProposeRefinementActivityOutput | null> =>
        runAgentActivity(() =>
          buildUserValidateActivities(remainingMs()).proposeRefinement({
            runId: id,
            tenantId: input.tenantId,
            productId: input.productId,
            runnerName: preparedSandbox.runtime.validatorRunner,
            spriteId: preparedSandbox.spriteId,
            adapter: preparedSandbox.adapter,
            workspacePath: preparedSandbox.workspacePath,
            primaryPath: preparedSandbox.primaryPath,
            workItemText: `${input.workItem.title}\n\n${input.workItem.description}`,
            goal: refined.goal,
            statedCriteria: refined.acceptanceCriteria,
            contextContract: resolvedContext.document,
            skills: preparedSandbox.skills,
            previewConfigured: preparedSandbox.preview !== null && preparedSandbox.preview.enabled,
            timeoutMs: remainingMs(),
            ...(afterHang ? { afterHang: true } : {}),
          }),
        );
      try {
        proposal = await proposeOnce(false);
        // docs/specs/agent-session-usage-and-hangs.md. A hung refiner gets one fresh session.
        const firstHang = hangOf(proposal);
        if (firstHang !== null && !stopRequested && remainingMs() > 0) {
          await reportHang("refiner", firstHang, "starts one fresh session");
          proposal = await proposeOnce(true);
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
      const refinerHang = hangOf(proposal);
      if (refinerHang !== null) {
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
        return await failHung("refiner", refinerHang);
      }
      if (proposal.status !== "proposed") {
        return await failRun(
          "REFINEMENT_UNAVAILABLE",
          `Factoree could not use the Refiner proposal. ${proposal.reason} Factoree published nothing.`,
        );
      }
      // A refiner that freezes nothing leaves the criteria the Work Item states.
      const contractCriteria = proposal.accepted.length === 0 ? refined.criteria : proposal.accepted;
      const validationAnswers: string[] = [];
      // docs/specs/own-proposals-and-parallel-runs.md. Every proposal of the gate is determined, so
      // Factoree takes it and asks nobody. The proof pack lists each one for the reviewer.
      for (const decision of proposal.decisions) await takeDecision(decision);

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
      let repairFindings: string[] = [];
      let repairCount = 0;
      const maxRepairs = preparedSandbox.runtime.repairMaxAttempts;
      // docs/specs/agent-session-usage-and-hangs.md. The hung Implementer session the next attempt
      // resumes, and whether the current step already resumed one. One step allows one hang.
      let continueSession: AgentSessionRef | null = null;
      let resumedAfterHang = false;

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
      let publishedFakes: Array<{ service: string; name: string }> = [];
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
              "and the repair budget is spent, so Factoree cannot resume it",
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
          return await failRun(
            "IMPLEMENTATION_FAILED",
            "The Implementer did not complete the change. Factoree ended the Run.",
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
              "Deterministic verification did not pass, and the repair budget is spent. " +
                `${verification.summary} Factoree published nothing.`,
            );
          }
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

          repairCount += 1;
          signalRepairs = repairCount;
          attempt += 1;
          repairFindings = verification.failures;
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
              // docs/specs/agent-session-usage-and-hangs.md. A hung Reviewer gets one fresh session
              // in the same review pass.
              const hang = hangOf(result);
              if (hang !== null && !stopRequested && remainingMs() > 0) {
                await reportHang("reviewer", hang, "starts one fresh session");
                result = await runReview({ ...reviewInput, afterHang: true });
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
          // docs/specs/agent-session-usage-and-hangs.md. A hung validator gets one fresh session.
          const validatorHang = hangOf(result);
          if (validatorHang !== null && remainingMs() > 0) {
            await reportHang("validator", validatorHang, "starts one fresh session");
            result = await runUserValidate({ prepared: checked, goal: sandbox.goal, attempt, afterHang: true });
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
                "User validation did not pass, and the repair budget is spent. " +
                  `${userValidation.summary} Factoree published nothing.`,
              );
            }
            if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

            repairCount += 1;
            signalRepairs = repairCount;
            attempt += 1;
            repairFindings = [...userValidation.failures, ...reviewFindings];
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
          // docs/specs/agent-session-usage-and-hangs.md. A hung Reviewer gets one fresh session in
          // the same review pass.
          const reviewerHang = hangOf(result);
          if (reviewerHang !== null && remainingMs() > 0) {
            await reportHang("reviewer", reviewerHang, "starts one fresh session");
            result = await runReview({ ...reviewInput, afterHang: true });
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
          publishedChangeDescription = review.changeDescription;
          break;
        }

        // SDD section 42. A blocking finding enters the same bounded repair loop.
        if (repairCount >= maxRepairs) {
          return await failRun(
            "REVIEW_BLOCKING_FINDINGS",
            "The independent review rejected this change, and the repair budget is spent. " +
              `${review.summary} Factoree published nothing.`,
          );
        }
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        repairCount += 1;
        signalRepairs = repairCount;
        attempt += 1;
        repairFindings = review.failures;
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
      // (docs/specs/run-recovery.md).
      const publishDraft =
        refined.autonomyLevel !== "L3" ||
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
        baseBranch: defaultBranchForSlug(resolvedContext.primary.slug),
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

      let publication: PublishActivityOutput;
      try {
        publication = await publishingActivities.publish(publishInput);
      } catch (error) {
        if (isCancellation(error)) throw error;
        // SDD section 50. A human stop is never a configuration fault. It is never a publication
        // failure either, because this path published nothing.
        if (stopRequested) return await cancelRun();
        if (isConfigurationFault(error)) {
          return await failRun(
            "CONFIGURATION_INVALID",
            withCause(
              "Factoree could not publish, because the Run configuration is invalid. Install the " +
                "Factoree GitHub App on the target repository, so Factoree can mint a write " +
                "credential that no agent session receives.",
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
              : "Factoree could not publish the verified change. Factoree created no pull request " +
                  "for it.",
        );
      }

      await notify(() =>
        activities.postProgress({
          sessionId: input.agentSessionId,
          message: `Factoree opened the pull request: ${publication.pullRequestUrl}.`,
        }),
      );

      // The publication succeeded. A later stop message and a later timeout message read this
      // value, so neither one claims that Factoree published nothing.
      publishedPullRequestUrl = publication.pullRequestUrl;

      // Specification section 14. The patch hash and commit SHA are known after publication, and
      // the pull request URL is known once the pull request exists. All three describe the same
      // moment here.
      await activities.recordRunTargetFacts({
        tenantId: input.tenantId,
        runId: id,
        repositoryId: primaryRepositoryId,
        patchSha256: publication.patchSha256,
        commitSha: publication.commitSha,
        pullRequestUrl: publication.pullRequestUrl,
      });

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
          runId: id,
          tenantId: input.tenantId,
          productId: input.productId,
          sessionId: input.agentSessionId,
          workItem: { title: input.workItem.title, url: input.workItem.url },
          pullRequestUrl: publication.pullRequestUrl,
          commitSha: publication.commitSha,
          patchSha256: publication.patchSha256,
          baseSha: publishInput.baseSha,
          changedFiles: publishedChangedFiles,
          patchByteLength: publication.patchByteLength,
          previewUrl: publishedPreviewUrl,
          fakes: publishedFakes,
          repairCount,
          repairLimit: maxRepairs,
          reviewVerdict: publishedReviewVerdict,
          reviewPasses: publishedReviewPasses,
          reviewAttempt: publishedReviewAttempt,
          changeDescription: publishedChangeDescription,
          visualEvidenceGap,
          decisions: factoreeDecisions,
          baseMove:
            publication.baseMove === null
              ? null
              : { baseBranch: publishInput.baseBranch, ...publication.baseMove },
          autonomyLevel: refined.autonomyLevel,
          autonomyReasons: refined.autonomyReasons,
          checkDefiningFiles: published.checkDefiningFiles,
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
            `pull request by hand. Pull request: ${publication.pullRequestUrl}.`,
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
        patchSha256: publication.patchSha256,
        pullRequestUrl: publication.pullRequestUrl,
        proofPackSha256: proofPack.sha256,
      });

      if (unmet.length > 0) {
        return await failRun(
          "COMPLETION_INVARIANT_UNMET",
          "Factoree published the verified change and cannot report it complete. " +
            `${unmet.join(" ")} Pull request: ${publication.pullRequestUrl}.`,
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
