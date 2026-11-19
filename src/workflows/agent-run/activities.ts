import { ActivityCancellationType, proxyActivities } from "@temporalio/workflow";
import type { Activities } from "~/activities/index.js";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import { RUN_CONFIGURATION_ERROR_TYPE } from "../../domain/runs/run-configuration-error.js";
import { SANDBOX_PROVIDER_DOWN_TYPE, SANDBOX_SLOT_UNAVAILABLE_TYPE } from "../../domain/runs/sandbox-slot-error.js";

/** The activity options of the run workflow. Each proxy names the steps it serves. */

const retry = (maximumAttempts: number, initialInterval: string, nonRetryableErrorTypes?: string[]) => ({
  maximumAttempts,
  initialInterval,
  backoffCoefficient: 2,
  ...(nonRetryableErrorTypes === undefined ? {} : { nonRetryableErrorTypes }),
});

export const activities = proxyActivities<Activities>({ startToCloseTimeout: "1 minute", retry: retry(5, "1 second") });

/** Refinement is a pure computation, so it is fast, and a retry costs nothing. */
export const refineActivities = proxyActivities<Activities>({ startToCloseTimeout: "1 minute", retry: retry(3, "1 second") });

/** The Validation Contract build is a pure computation plus one database write. */
export const validationActivities = proxyActivities<Activities>({ startToCloseTimeout: "1 minute", retry: retry(5, "1 second") });

/** The longest one context resolution attempt can take. */
const RESOLVE_ATTEMPT_TIMEOUT_MS = 30 * 60_000;

/**
 * Context resolution clones and reads repositories, so the remaining Run budget bounds it. SDD
 * section 49: a repository reference that resolves to nothing repeats on every attempt, so it
 * fails fast.
 */
export const buildContextActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${Math.min(RESOLVE_ATTEMPT_TIMEOUT_MS, budgetMs)} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs} milliseconds`,
    retry: retry(3, "5 seconds", [RUN_CONFIGURATION_ERROR_TYPE]),
  });

/** docs/specs/work-item-images-and-links.md. Up to 10 images of 10 MiB and up to 10 links. */
export const workItemActivities = proxyActivities<Activities>({ startToCloseTimeout: "10 minutes", retry: retry(3, "5 seconds") });

/** The longest one preparation attempt can take. A retry gets its own attempt of this length. */
const PREPARE_ATTEMPT_TIMEOUT_MS = 30 * 60_000;

/**
 * Preparation clones every repository and runs the bootstrap command. `scheduleToCloseTimeout`
 * keeps every attempt inside the remaining Run budget. A configuration fault fails fast. A full
 * sandbox provider is no fault: the workflow waits for a slot itself (DI-15.14).
 */
export const buildSandboxActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${Math.min(PREPARE_ATTEMPT_TIMEOUT_MS, budgetMs)} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs} milliseconds`,
    retry: retry(3, "5 seconds", [RUN_CONFIGURATION_ERROR_TYPE, SANDBOX_SLOT_UNAVAILABLE_TYPE, SANDBOX_PROVIDER_DOWN_TYPE]),
  });

/** The margin an agent session keeps after the Run budget ends, for its cancel and its row. */
const SESSION_MARGIN_MS = 5 * 60_000;

/**
 * SDD sections 36, 42 and 50. An agent session (implementer, refiner, validator, reviewer,
 * triage) is bounded by the remaining Run budget, heartbeats so a cancel reaches it, and runs
 * once: a failed attempt is a result, never a retry. The workflow waits for the cancelled
 * activity, so its evidence still reaches the AgentExecution row.
 */
export const buildSessionActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${budgetMs + SESSION_MARGIN_MS} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs + SESSION_MARGIN_MS} milliseconds`,
    heartbeatTimeout: "120000 milliseconds",
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
  });

/** The longest one verification pass can take. */
const VERIFY_ATTEMPT_TIMEOUT_MS = 60 * 60_000;

/** Verification returns a failing check as a result, so a retry covers only a transport fault. */
export const buildVerifyActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${Math.min(VERIFY_ATTEMPT_TIMEOUT_MS, budgetMs)} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs} milliseconds`,
    retry: retry(3, "5 seconds"),
  });

const PUBLICATION_FAILURE_TYPES = [RUN_CONFIGURATION_ERROR_TYPE, "PATCH_HASH_MISMATCH", "EMPTY_PATCH", "PUBLICATION_FAILED"];

/**
 * SDD section 46. Every publication step is idempotent, so a retry is safe. DI-9.8 keeps the
 * branch name and the pull request lookup deterministic. The semantic types fail fast.
 */
export const publishingActivities = proxyActivities<Activities>({
  startToCloseTimeout: "15 minutes",
  heartbeatTimeout: "2 minutes",
  retry: retry(3, "2 seconds", PUBLICATION_FAILURE_TYPES),
});

/** SDD section 47. A missing input is the only Proof Pack failure a retry cannot repair. */
export const proofPackActivities = proxyActivities<Activities>({
  startToCloseTimeout: "5 minutes",
  retry: retry(3, "1 second", [RUN_CONFIGURATION_ERROR_TYPE, "PROOF_PACK_INPUT_MISSING"]),
});

/** The replies to the dropped PR reviewer findings make one GitHub call per finding. */
export const pullRequestReplyActivities = proxyActivities<Activities>({ startToCloseTimeout: "10 minutes", retry: retry(3, "5 seconds") });

/** Slice 4. The trusted merge of the base clones the repository and sends no heartbeat. */
export const bringCurrentActivities = proxyActivities<Activities>({ startToCloseTimeout: "15 minutes", retry: retry(3, "2 seconds", PUBLICATION_FAILURE_TYPES) });

/** The cancel of a live session and the release of a sprite run after the budget, so they get their own timeout. */
export const cancelActivities = proxyActivities<Activities>({ startToCloseTimeout: "1 minute", retry: retry(3, "1 second") });
