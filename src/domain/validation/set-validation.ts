import type { SandboxRef } from "~/domain/runs/sandbox.js";
import {
  aloneNotes,
  checkGroupsOf,
  planTargetRulesOf,
  startGroup,
  stopGroup,
  type RunningGroup,
  type SetCheckFacts,
  type SetCheckTarget,
} from "~/domain/runs/set-check.js";
import { pauseServices, startServices, type FakeService } from "~/domain/runs/services.js";
import { bootstrapScript } from "~/domain/runs/sandbox-manager.js";
import { runVerification } from "~/domain/runs/verification.js";
import { applyPatch, capturePatch, PatchError, trustedGit } from "~/domain/publishing/patch.js";
import type { ForYourEyeCriterion, ForYourEyeCapture } from "~/domain/validation/for-your-eye.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import {
  parseValidationPlan,
  servedTargetOf,
  ValidationPlanInvalidError,
  type PlanTargetRules,
  type ValidationPlan,
  type ValidationPlanEntry,
} from "~/domain/validation/validation-plan.js";
import { summarizeUserValidation, type AssertionOutcome, type UserValidationOutcome } from "~/domain/validation/validation-result.js";
import { runUserValidation, type SelectorRecheck, type UserValidatorDependencies } from "~/domain/validation/user-validator.js";

/**
 * docs/specs/change-sets.md, slice 6. User validation of a change set in one check sprite. Each
 * plan entry names its target. The groups run one after the other: a wired group with its stacks,
 * its forwards and its provider previews together, and every other target with its stack alone.
 * After the full set passes, the in-between check resets each consumer to its base, keeps the
 * provider patches, and runs its verify commands and its paired entries.
 */

export interface SetValidationInput {
  runId: string;
  tenantId: string;
  ref: SandboxRef;
  /** The folder that holds every target, `<workspace>/targets`. */
  targetsPath: string;
  contract: ValidationContract;
  planText: string | null;
  rejectedPlanReason?: string;
  /** Project test secrets only. SDD section 30. */
  environment: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  forYourEye?: readonly ForYourEyeCriterion[];
  selectorRecheck?: SelectorRecheck;
  facts: SetCheckFacts;
  /** DI-21.141. The cited provider-to-consumer edges of the run. */
  edges: ReadonlyArray<{ provider: string; consumer: string }>;
  /** The targets whose patch changes a file. */
  changed: readonly string[];
}

export interface SetValidationOutcome extends UserValidationOutcome {
  /** The fakes that answered, each with the target whose stack holds it. A replaced fake is absent. */
  fakes: Array<FakeService & { target: string }>;
  /** DI-21.148. One line per pair that ran alone, for "Needs your attention". */
  notes: string[];
  /** DI-21.149. One repair finding per consumer that failed the in-between check. */
  inBetweenFailures: string[];
}

const sameName = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** The plan of a valid text, or null. A rejected plan blocks every automated assertion in one pass. */
const parsedPlanOf = (text: string | null, contract: ValidationContract, rules: PlanTargetRules): ValidationPlan | null => {
  if (text === null) return null;
  try {
    return parseValidationPlan(text, contract, [], rules);
  } catch (error) {
    if (error instanceof ValidationPlanInvalidError) return null;
    throw error;
  }
};

export const runSetUserValidation = async (
  dependencies: UserValidatorDependencies,
  input: SetValidationInput,
): Promise<SetValidationOutcome> => {
  const { facts } = input;
  const rules = planTargetRulesOf(facts);
  const groups = checkGroupsOf(facts.targets, facts.pairs);
  const deadline = Date.now() + input.timeoutMs;
  const remaining = (): number => Math.max(1, deadline - Date.now());
  const byName = new Map(facts.targets.map((target) => [target.repository, target]));
  const groupDependencies = { sandbox: dependencies.sandbox, probe: dependencies.probe, redactor: dependencies.redactor };
  const forYourEye = input.forYourEye ?? [];
  const replaced = new Set(facts.pairs.map((pair) => `${pair.consumer} ${pair.fake}`));
  const fakes = facts.targets.flatMap((target) =>
    target.fakes.filter((fake) => !replaced.has(`${target.repository} ${fake.service}`)).map((fake) => ({ ...fake, target: target.repository })),
  );
  const notes = aloneNotes(facts.alone);

  const plan = parsedPlanOf(input.planText, input.contract, rules);
  if (plan === null) {
    // Rule 2 of the pass: no plan, or a plan the rules reject, blocks every automated assertion.
    const whole = await runUserValidation(dependencies, {
      runId: input.runId,
      tenantId: input.tenantId,
      ref: input.ref,
      primaryPath: input.targetsPath,
      contract: input.contract,
      preview: null,
      planText: input.planText,
      environment: input.environment,
      timeoutMs: remaining(),
      planRules: rules,
      ...(input.rejectedPlanReason === undefined ? {} : { rejectedPlanReason: input.rejectedPlanReason }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      forYourEye,
    });
    return { ...whole, fakes, notes, inBetweenFailures: [] };
  }

  const served = new Map<string, string>();
  for (const entry of plan.entries) {
    const target = servedTargetOf(entry.target, rules);
    if (target !== null) served.set(entry.assertionId, target);
  }
  // A for-your-eye route is a help for the human, not evidence, and names no target: it is captured
  // from the first target with an enabled preview (DI-21.147).
  const eyeTarget = forYourEye.length === 0 ? null : (facts.targets.find((target) => target.preview?.enabled === true)?.repository ?? null);

  const outcomes = new Map<string, AssertionOutcome>();
  const captures: ForYourEyeCapture[] = [];
  const ranEntries = new Map<string, ValidationPlanEntry>();

  /** Runs the entries one target serves, in the group that runs now. */
  const runServed = async (
    target: SetCheckTarget,
    entries: ValidationPlanEntry[],
    running: RunningGroup | null,
    extra: { forYourEye: readonly ForYourEyeCriterion[]; selectorRecheck: boolean },
  ): Promise<UserValidationOutcome> => {
    const ids = new Set(entries.map((entry) => entry.assertionId));
    const shared = running?.previews.get(target.repository);
    const problem = running?.problem ?? null;
    return runUserValidation(dependencies, {
      runId: input.runId,
      tenantId: input.tenantId,
      ref: input.ref,
      primaryPath: target.path,
      contract: { ...input.contract, assertions: input.contract.assertions.filter((assertion) => ids.has(assertion.id)) },
      preview: target.preview,
      planText: JSON.stringify({ version: 1, entries }),
      environment: { ...input.environment, ...target.environment },
      timeoutMs: remaining(),
      accounts: target.accounts,
      ...(target.browserLimits === undefined ? {} : { browserLimits: target.browserLimits }),
      planRules: rules,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      forYourEye: extra.forYourEye,
      ...(extra.selectorRecheck && input.selectorRecheck !== undefined ? { selectorRecheck: input.selectorRecheck } : {}),
      ...(shared === undefined ? {} : { sharedPreview: shared }),
      ...(problem === null
        ? {}
        : {
            previewUnavailable: {
              reason: `The preview of ${problem.repository} did not start, so the wired group of ${target.repository} cannot run: ${problem.reason}`,
              log: problem.log,
            },
          }),
    });
  };

  /** Runs one group: its stacks and providers together when wired, or one stack alone. */
  const withGroup = async <T>(group: readonly string[], work: (running: RunningGroup | null) => Promise<T>): Promise<T> => {
    if (group.length > 1) {
      const running = await startGroup(groupDependencies, input.ref, facts, group, { previews: "providers", environment: input.environment });
      try {
        return await work(running);
      } finally {
        await stopGroup(dependencies.sandbox, input.ref, facts, running);
      }
    }
    const target = byName.get(group[0] ?? "");
    const services = target?.services ?? null;
    if (target === undefined || services === null) return work(null);
    await startServices(dependencies.sandbox, input.ref, target.path, services);
    try {
      return await work(null);
    } finally {
      await pauseServices(dependencies.sandbox, input.ref, target.path, services);
    }
  };

  for (const group of groups) {
    const servers = group.filter(
      (repository) => plan.entries.some((entry) => served.get(entry.assertionId) === repository) || repository === eyeTarget,
    );
    if (servers.length === 0) continue;
    input.signal?.throwIfAborted();
    await withGroup(group, async (running) => {
      for (const repository of servers) {
        const target = byName.get(repository);
        if (target === undefined) continue;
        const entries = plan.entries.filter((entry) => served.get(entry.assertionId) === repository);
        const result = await runServed(target, entries, running, {
          forYourEye: repository === eyeTarget ? forYourEye : [],
          selectorRecheck: true,
        });
        for (const outcome of result.outcomes) outcomes.set(outcome.assertionId, outcome);
        captures.push(...(result.forYourEye ?? []));
        for (const entry of result.plan?.entries ?? []) ranEntries.set(entry.assertionId, entry);
      }
    });
  }

  // A manual assertion, and an automated one the plan does not cover, run nothing.
  const rest = input.contract.assertions.filter((assertion) => !outcomes.has(assertion.id));
  if (rest.length > 0) {
    const result = await runUserValidation(dependencies, {
      runId: input.runId,
      tenantId: input.tenantId,
      ref: input.ref,
      primaryPath: input.targetsPath,
      contract: { ...input.contract, assertions: rest },
      preview: null,
      planText: JSON.stringify({ version: 1, entries: [] }),
      environment: input.environment,
      timeoutMs: remaining(),
      planRules: rules,
    });
    for (const outcome of result.outcomes) outcomes.set(outcome.assertionId, outcome);
  }

  const ordered = input.contract.assertions.map((assertion) => outcomes.get(assertion.id)).filter((outcome): outcome is AssertionOutcome => outcome !== undefined);
  const summary = summarizeUserValidation(ordered);
  const ranPlan: ValidationPlan = { ...plan, entries: plan.entries.map((entry) => ranEntries.get(entry.assertionId) ?? entry) };

  // DI-21.149. Production runs the state between the two merges, so a set that passed is checked there.
  const inBetweenFailures = summary.passed ? await inBetweenCheck(dependencies, input, { plan: ranPlan, served, groups, runServed, withGroup, remaining }) : [];
  const inBetweenLine =
    inBetweenFailures.length === 0
      ? ""
      : ` The in-between check failed for ${inBetweenFailures.length === 1 ? "one consumer" : `${String(inBetweenFailures.length)} consumers`}.`;
  return {
    ...summary,
    passed: summary.passed && inBetweenFailures.length === 0,
    summary: `${summary.summary}${inBetweenLine}`,
    failures: [...summary.failures, ...inBetweenFailures],
    forYourEye: captures,
    plan: ranPlan,
    fakes,
    notes,
    inBetweenFailures,
  };
};

/**
 * DI-21.149. The consumers whose base the provider patches can break: a consumer of a cited edge or
 * of a wired pair whose own patch changes a file, with at least one such provider that changed.
 */
export const inBetweenConsumersOf = (
  facts: Pick<SetCheckFacts, "targets" | "pairs">,
  edges: ReadonlyArray<{ provider: string; consumer: string }>,
  changed: readonly string[],
): Array<{ consumer: string; providers: string[] }> => {
  const isChanged = (repository: string): boolean => changed.some((name) => sameName(name, repository));
  const links = [...edges, ...facts.pairs];
  const result: Array<{ consumer: string; providers: string[] }> = [];
  for (const target of facts.targets) {
    if (!isChanged(target.repository)) continue;
    const providers = [
      ...new Set(
        links
          .filter((link) => sameName(link.consumer, target.repository) && !sameName(link.provider, target.repository) && isChanged(link.provider))
          .map((link) => facts.targets.find((candidate) => sameName(candidate.repository, link.provider))?.repository ?? link.provider),
      ),
    ];
    if (providers.length > 0) result.push({ consumer: target.repository, providers });
  }
  return result;
};

const inBetweenCheck = async (
  dependencies: UserValidatorDependencies,
  input: SetValidationInput,
  pass: {
    plan: ValidationPlan;
    served: ReadonlyMap<string, string>;
    groups: string[][];
    runServed: (
      target: SetCheckTarget,
      entries: ValidationPlanEntry[],
      running: RunningGroup | null,
      extra: { forYourEye: readonly ForYourEyeCriterion[]; selectorRecheck: boolean },
    ) => Promise<UserValidationOutcome>;
    withGroup: <T>(group: readonly string[], work: (running: RunningGroup | null) => Promise<T>) => Promise<T>;
    remaining: () => number;
  },
): Promise<string[]> => {
  const findings: string[] = [];
  const patchDependencies = { sandbox: dependencies.sandbox, redactor: dependencies.redactor };
  for (const { consumer, providers } of inBetweenConsumersOf(input.facts, input.edges, input.changed)) {
    const target = input.facts.targets.find((candidate) => candidate.repository === consumer);
    if (target === undefined) continue;
    input.signal?.throwIfAborted();
    const failures: string[] = [];
    // The consumer patch goes aside, the worktree returns to the base, and the patch comes back after.
    const saved = await capturePatch(patchDependencies, { ref: input.ref, primaryPath: target.path, baseSha: target.baseSha });
    const git = async (args: string[]): Promise<void> => {
      const result = await trustedGit(dependencies.sandbox, input.ref, ["-C", target.path, ...args]);
      if (result.exitCode !== 0) throw new PatchError(`git ${args.join(" ")} failed with exit code ${result.exitCode}: ${dependencies.redactor.redactText(result.stderr.trim())}`);
    };
    try {
      await git(["reset", "-q", "--hard", target.baseSha]);
      await git(["clean", "-fdq"]);
      // The base needs its own dependencies, with its stack up for a migration, then its verify commands.
      await pass.withGroup([consumer], async () => {
        if (target.bootstrapCommand !== null) {
          const bootstrap = await dependencies.sandbox.exec(input.ref, {
            file: "sh",
            args: ["-c", bootstrapScript(target.bootstrapCommand)],
            cwd: target.path,
            ...(Object.keys(target.environment).length === 0 ? {} : { env: target.environment }),
          });
          if (bootstrap.exitCode !== 0) {
            failures.push(`its bootstrap failed with exit code ${String(bootstrap.exitCode)}: ${dependencies.redactor.redactText(`${bootstrap.stderr}\n${bootstrap.stdout}`.trim()).slice(-1500)}`);
            return;
          }
        }
        const verification = await runVerification({
          sandbox: dependencies.sandbox,
          ref: input.ref,
          workingDirectory: target.path,
          commands: target.verifyCommands,
          environment: input.environment,
          timeoutMs: pass.remaining(),
          redactor: dependencies.redactor,
        });
        for (const check of verification.checks.filter((candidate) => !candidate.passed)) {
          failures.push(`the verify command "${check.name}" exited ${String(check.exitCode)}${check.log === null ? "" : `:\n${check.log}`}`);
        }
      });
      // Its paired entries run in its wired group, with the provider previews patched.
      const group = pass.groups.find((candidate) => candidate.includes(consumer)) ?? [consumer];
      const paired = group.length > 1 ? pass.plan.entries.filter((entry) => pass.served.get(entry.assertionId) === consumer) : [];
      if (failures.length === 0 && paired.length > 0) {
        const result = await pass.withGroup(group, (running) => pass.runServed(target, paired, running, { forYourEye: [], selectorRecheck: false }));
        for (const outcome of result.outcomes.filter((candidate) => candidate.result !== "PASS")) {
          failures.push(`${outcome.assertionId} is ${outcome.result}: ${outcome.reason}`);
        }
      }
    } finally {
      await git(["reset", "-q", "--hard", target.baseSha]);
      await git(["clean", "-fdq"]);
      await applyPatch(patchDependencies, { ref: input.ref, primaryPath: target.path, baseSha: target.baseSha, patchBase64: saved.patchBase64 });
    }
    if (failures.length === 0) continue;
    dependencies.logger.warn("the in-between check failed", { run_id: input.runId, step: "user_validate", consumer, providers: providers.join(", ") });
    findings.push(
      `The in-between check failed: the patch of ${providers.join(" and ")} breaks ${consumer} at its base ${target.baseSha.slice(0, 7)}, ` +
        "the state production runs between the two merges. Change the provider so that the consumer still works before its own change merges. " +
        `With the provider ${providers.length === 1 ? "patch" : "patches"} applied and ${consumer} at its base, ${failures.join("; ")}`,
    );
  }
  return findings;
};
