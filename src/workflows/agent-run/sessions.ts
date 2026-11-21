import { deprecatePatch } from "@temporalio/workflow";
import type { PrepareCheckSandboxActivityOutput, PrepareSandboxActivityOutput } from "~/activities/sandbox.activities.js";
import type { ImplementActivityOutput } from "~/activities/agent.activities.js";
import type { UserValidateActivityOutput } from "~/activities/validation.activities.js";
import type { ReviewActivityOutput } from "~/activities/review.activities.js";
import type { AgentSessionRef } from "~/domain/runs/agent-runner.js";
import type { ForYourEyeCriterion } from "~/domain/validation/for-your-eye.js";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import { describeAgentRole, describeSilenceLimit, type AgentSessionRole } from "../../domain/runs/agent-session.js";
import { describeDecision } from "../../domain/runs/factoree-decision.js";
import { allowListCovers } from "../../domain/runs/sandbox.js";
import type { EgressFacts } from "../../domain/runs/egress.js";
import { buildSessionActivities } from "./activities.js";
import { PATCH } from "./patches.js";
import type { Run } from "./run.js";

/** docs/specs/provider-unreachable.md. The sessions of one step before the Run ends: the first and two retries. */
export const PROVIDER_UNREACHABLE_ATTEMPTS = 3;
/** docs/specs/provider-unreachable.md. The most characters of provider detail a failure message carries. */
const PROVIDER_DETAIL_MAX_CHARS = 1_000;

type SessionOutcome = { hang?: { silenceLimitMs: number } | null; providerUnreachable?: { summary: string } | null } | null;

/**
 * docs/specs/agent-session-usage-and-hangs.md. The hang an agent activity reported. A result
 * recorded before the field existed carries none, and reads as no hang. DI-14.48.
 */
export const hangOf = (output: SessionOutcome): { silenceLimitMs: number } | null => output?.hang ?? null;

/** docs/specs/provider-unreachable.md. The provider failure an agent activity reported, or none. */
export const providerUnreachableOf = (output: SessionOutcome): { summary: string } | null => {
  deprecatePatch(PATCH.providerUnreachable);
  return output?.providerUnreachable ?? null;
};

/**
 * DI-21.46. The egress facts of one sandbox for an agent prompt, or null for a sandbox prepared
 * before the facts existed. A bootstrap host the agent phase also reaches is no bootstrap-only host.
 */
export const egressOf = (prepared: PrepareSandboxActivityOutput): EgressFacts | null => {
  const allowed = prepared.allowedHosts;
  if (allowed === undefined) return null;
  return {
    allowed,
    bootstrapOnly: (prepared.runtime.bootstrapAllowedDomains ?? []).filter((host) => !allowListCovers(allowed, host)).sort(),
  };
};

/** docs/specs/change-sets.md. The targets of a change set for an activity input, or nothing for one target. */
export const setTargetsInput = (prepared: { targets?: Array<{ repository: string; path: string; baseSha: string }> }) =>
  prepared.targets !== undefined && prepared.targets.length > 1 ? { targets: prepared.targets } : {};

/** The sprite fields every activity on a sprite takes. */
export const spriteOf = (prepared: PrepareSandboxActivityOutput) => ({
  spriteId: prepared.spriteId,
  adapter: prepared.adapter,
  workspacePath: prepared.workspacePath,
  primaryPath: prepared.primaryPath,
});

/** The retry fields of a session input: present only for a fresh session after a hang or an outage. */
const retryFields = (afterHang: boolean, unreachableRetry: number) => ({
  ...(afterHang ? { afterHang: true } : {}),
  ...(unreachableRetry > 0 ? { unreachableRetry } : {}),
});

/** docs/specs/agent-session-usage-and-hangs.md. One hung session gets one more try, and the human sees it. */
export const reportHang = async (run: Run, role: AgentSessionRole, hang: { silenceLimitMs: number }, next: string): Promise<void> => {
  await run.progress(
    `The ${describeAgentRole(role)} session wrote no output for ${describeSilenceLimit(hang.silenceLimitMs)}, so Factoree stopped it and ${next}.`,
  );
};

/**
 * docs/specs/provider-unreachable.md. Runs a session again while the provider stays unreachable,
 * at most twice, and returns the last result. A retry does not touch the repair budget. A retry
 * after a hang numbers on from the first series, so no retry reuses the files of another.
 */
export const retryWhileUnreachable = async <T extends SessionOutcome>(
  run: Run,
  role: AgentSessionRole,
  first: T,
  again: (retry: number) => Promise<T>,
  retryOffset: number,
): Promise<T> => {
  let result = first;
  for (let retry = 1; retry < PROVIDER_UNREACHABLE_ATTEMPTS; retry += 1) {
    if (providerUnreachableOf(result) === null || run.stopped || run.remainingMs() === 0) break;
    await run.progress(
      `The ${describeAgentRole(role)} session could not reach the model provider, ` +
        `so Factoree starts one fresh session (retry ${retry} of ${PROVIDER_UNREACHABLE_ATTEMPTS - 1}).`,
    );
    result = await again(retryOffset + retry);
  }
  return result;
};

/**
 * One fresh-session step of the refiner, the validator, the reviewer or the triage: the session,
 * its retries while the provider is unreachable, and one fresh session after a hang with its own
 * retries. The caller reads a stop and the outcome.
 */
export const runSession = async <T extends SessionOutcome>(
  run: Run,
  role: AgentSessionRole,
  once: (afterHang: boolean, unreachableRetry: number) => Promise<T>,
): Promise<T> => {
  let result = await retryWhileUnreachable(run, role, await once(false, 0), (retry) => once(false, retry), 0);
  const hang = hangOf(result);
  if (hang !== null && !run.stopped && run.remainingMs() > 0) {
    await reportHang(run, role, hang, "starts one fresh session");
    result = await retryWhileUnreachable(run, role, await once(true, 0), (retry) => once(true, retry), PROVIDER_UNREACHABLE_ATTEMPTS - 1);
  }
  return result;
};

/**
 * docs/specs/provider-unreachable.md. Ends the Run when a role could not reach the model provider
 * on its last retry. The message names the role and the agent's own API error.
 */
export const failProviderUnreachable = (run: Run, role: AgentSessionRole, unreachable: { summary: string }): Promise<never> => {
  const detail = unreachable.summary.trim().slice(0, PROVIDER_DETAIL_MAX_CHARS).trim();
  return run.fail(
    "PROVIDER_UNREACHABLE",
    `The ${describeAgentRole(role)} session could not reach the model provider ${PROVIDER_UNREACHABLE_ATTEMPTS} times in the same step, ` +
      `so Factoree ended the Run. Provider error: ${detail === "" ? "none reported" : detail} ` +
      "Factoree published nothing.",
  );
};

/** docs/specs/agent-session-usage-and-hangs.md. A second hang in the same step ends the Run. */
export const failHung = (
  run: Run,
  role: AgentSessionRole,
  hang: { silenceLimitMs: number },
  reason = "for the second time in the same step",
  hint = "",
): Promise<never> =>
  run.fail(
    "AGENT_HUNG",
    `The ${describeAgentRole(role)} session wrote no output for ${describeSilenceLimit(hang.silenceLimitMs)} ` +
      `${reason}, so Factoree stopped it and ended the Run. ${hint === "" ? "" : `${hint} `}Factoree published nothing.`,
  );

/** A session that ended unreachable or hung after its retries ends the Run, or the deadline ends it first. */
export const endIfSessionFailed = async (run: Run, role: AgentSessionRole, outcome: SessionOutcome): Promise<void> => {
  const unreachable = providerUnreachableOf(outcome);
  if (unreachable !== null) {
    await run.ensureTime();
    await failProviderUnreachable(run, role, unreachable);
  }
  const hang = hangOf(outcome);
  if (hang !== null) {
    await run.ensureTime();
    await failHung(run, role, hang);
  }
};

/** One Implementer attempt. It returns null when a stop cancelled the activity. */
export const runImplementer = async (
  run: Run,
  attempt: {
    prepared: PrepareSandboxActivityOutput;
    goal: string;
    attempt: number;
    unreachableRetry: number;
    repairFindings: string[];
    /** SDD section 21 and AT-09. The rendered contract and the required-context lines, no file body. */
    contextContract: string;
    requiredContext: string[];
    /** SDD sections 25 and 34. The frozen Validation Contract, which the store keeps the agent from changing. */
    validationContract: string;
    /** docs/specs/agent-session-usage-and-hangs.md. The hung session this attempt resumes. */
    continueSession: AgentSessionRef | null;
  },
): Promise<ImplementActivityOutput | null> => {
  const { input } = run;
  const prepared = attempt.prepared;
  const budgetMs = run.remainingMs();
  const implementation = await run.agentActivity(() =>
    buildSessionActivities(budgetMs).implement({
      runId: run.id,
      tenantId: input.tenantId,
      productId: input.productId,
      runnerName: prepared.runtime.implementerRunner,
      ...spriteOf(prepared),
      ...setTargetsInput(prepared),
      referencePaths: prepared.referencePaths,
      goal: attempt.goal,
      contextContract: attempt.contextContract,
      validationContract: attempt.validationContract,
      requiredContext: attempt.requiredContext,
      contextFiles: prepared.contextFiles ?? [],
      imageFiles: prepared.imageFiles ?? [],
      // docs/specs/own-proposals-and-parallel-runs.md. Factoree's own decisions count as a human answer.
      humanDecisions: [...run.control.humanInputs, ...run.factoreeDecisions.map(describeDecision)],
      repositoryInstructions: prepared.repositoryInstructions,
      skills: prepared.skills,
      // docs/specs/skill-registry.md. The registry hears which skills the session loaded.
      skillRegistry: input.product.skillRegistry ?? null,
      skillProposals: (input.product.skillRegistry ?? null) !== null || input.product.organizationSkillsRepository !== null,
      repairFindings: attempt.repairFindings,
      stagingRead: prepared.runtime.stagingRead,
      // docs/specs/implementer-self-check.md. Facts only: the checks Factoree runs, and whether agent-browser exists.
      verifyCommands: prepared.verifyCommands,
      selfCheck: prepared.selfCheckReady === true,
      egress: egressOf(prepared),
      timeoutMs: budgetMs,
      attempt: attempt.attempt,
      ...retryFields(false, attempt.unreachableRetry),
      ...(attempt.continueSession === null ? {} : { continueSession: attempt.continueSession }),
    }),
  );
  if (implementation !== null) {
    // The fallback cancel runs unless the activity itself really cancelled the session.
    run.implementerCancelled = implementation.cancelledSession;
    run.implementerSession = { sessionId: implementation.sessionId, processId: implementation.processId, runner: implementation.runner };
  }
  return implementation;
};

/** One User Validator pass, SDD section 36. The activity cancels its own live session on a stop. */
export const runUserValidate = async (
  run: Run,
  pass: {
    prepared: PrepareSandboxActivityOutput;
    goal: string;
    attempt: number;
    forYourEye: ForYourEyeCriterion[];
    edges: Array<{ provider: string; consumer: string }>;
    afterHang?: boolean;
    unreachableRetry?: number;
    /** Slice 4, D1. Replays the stored passing plan of the run with no validator session. */
    replay?: boolean;
  },
): Promise<UserValidateActivityOutput | null> => {
  const { input } = run;
  const prepared = pass.prepared;
  const budgetMs = run.remainingMs();
  return await run.agentActivity(() =>
    buildSessionActivities(budgetMs).userValidate({
      runId: run.id,
      tenantId: input.tenantId,
      productId: input.productId,
      runnerName: prepared.runtime.validatorRunner,
      ...spriteOf(prepared),
      goal: pass.goal,
      preview: prepared.preview,
      timeoutMs: budgetMs,
      attempt: pass.attempt,
      accounts: prepared.runtime.accounts ?? [],
      ...(prepared.runtime.browserLimits === undefined ? {} : { browserLimits: prepared.runtime.browserLimits }),
      services: prepared.runtime.services ?? null,
      imageFiles: prepared.imageFiles ?? [],
      egress: egressOf(prepared),
      // GitHub issue 93, DI-21.192. A command entry keeps the variables of the verify command it narrows.
      ...(prepared.verifyCommands.length === 0
        ? {}
        : { verifyCommands: prepared.verifyCommands.map((command) => ({ name: command.name, run: command.run })) }),
      ...retryFields(pass.afterHang === true, pass.unreachableRetry ?? 0),
      ...(pass.forYourEye.length === 0 ? {} : { forYourEye: pass.forYourEye }),
      ...(pass.replay === true ? { replay: true } : {}),
      // docs/specs/change-sets.md, slice 6. The set check: its groups, its edges and the changed targets.
      ...(prepared.setCheck === undefined
        ? {}
        : {
            setCheck: prepared.setCheck,
            edges: pass.edges,
            changedTargets: ((prepared as Partial<PrepareCheckSandboxActivityOutput>).checkedTargets ?? [])
              .filter((target) => target.changedFiles.length > 0)
              .map((target) => target.repository),
          }),
    }),
  );
};

/** One Reviewer pass, SDD sections 40 and 42. Every pass starts a new session (DI-8.11). */
export const runReview = async (
  run: Run,
  pass: {
    prepared: PrepareSandboxActivityOutput;
    goal: string;
    attempt: number;
    contextContract: string | null;
    constraints: string[];
    verificationSummary: string;
    /** Absent beside user validation (docs/specs/run-speed.md), present on the serial path. */
    validationEvidence?: string[];
    afterHang?: boolean;
    unreachableRetry?: number;
  },
): Promise<ReviewActivityOutput | null> => {
  const { input } = run;
  const prepared = pass.prepared;
  const budgetMs = run.remainingMs();
  return await run.agentActivity(() =>
    buildSessionActivities(budgetMs).review({
      runId: run.id,
      tenantId: input.tenantId,
      productId: input.productId,
      runnerName: prepared.runtime.reviewerRunner,
      ...spriteOf(prepared),
      baseSha: prepared.baseSha,
      ...setTargetsInput(prepared),
      goal: pass.goal,
      contextContract: pass.contextContract,
      constraints: pass.constraints,
      verificationSummary: pass.verificationSummary,
      ...(pass.validationEvidence === undefined ? {} : { validationEvidence: pass.validationEvidence }),
      repositoryInstructions: prepared.repositoryInstructions,
      imageFiles: prepared.imageFiles ?? [],
      timeoutMs: budgetMs,
      attempt: pass.attempt,
      ...retryFields(pass.afterHang === true, pass.unreachableRetry ?? 0),
    }),
  );
};
