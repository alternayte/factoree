import type { AccountConfig, PreviewConfig } from "~/domain/runs/project-runtime-config.js";
import {
  startPreview,
  stopPreview,
  PreviewStartError,
  type PreviewHandle,
  type ReadinessProbe,
} from "~/domain/runs/preview.js";
import {
  checkSelectorCorrection,
  parseValidationPlan,
  ValidationPlanInvalidError,
  planKindForMethod,
  type BrowserPlanEntry,
  type BrowserStep,
  type ValidationPlan,
  type ValidationPlanEntry,
} from "~/domain/validation/validation-plan.js";
import { forYourEyeSource, type ForYourEyeCapture, type ForYourEyeCriterion } from "~/domain/validation/for-your-eye.js";
import type {
  AssertionOutcome,
  EvidenceArtifact,
  UserValidationOutcome,
} from "~/domain/validation/validation-result.js";
import { summarizeUserValidation } from "~/domain/validation/validation-result.js";
import { executeHttpAssertion, type HttpValidationFetch } from "~/domain/validation/http-validation.js";
import { resolvePreviewUrl } from "~/domain/validation/preview-url.js";
import type {
  BrowserDriver,
  BrowserRunResult,
  BrowserSelectorFailure,
  BrowserSignInResult,
  BrowserStepEvent,
} from "~/domain/validation/browser-driver.js";
import {
  DEFAULT_BROWSER_LIMITS,
  effectiveBrowserLimits,
  type BrowserLimits,
} from "~/domain/validation/browser-limits.js";
import type { ValidationAssertion, ValidationContract } from "~/domain/validation/validation-contract.js";
import type { Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import type { Redactor } from "~/telemetry/redaction.js";
import type { Logger } from "~/telemetry/logger.js";

/**
 * SDD section 36. The User Validator uses a fresh context. It takes a frozen Validation
 * Contract and a declarative plan, starts the preview once, and executes each assertion.
 * It persists nothing and starts no agent.
 */
export interface UserValidatorDependencies {
  sandbox: Sandbox;
  browser: BrowserDriver;
  fetchImpl: HttpValidationFetch;
  probe: ReadinessProbe;
  redactor: Redactor;
  logger: Logger;
}

export interface UserValidationInput {
  runId: string;
  tenantId: string;
  ref: SandboxRef;
  primaryPath: string;
  contract: ValidationContract;
  preview: PreviewConfig | null;
  /** The plan text the fresh validator session wrote, or null when it wrote none. */
  planText: string | null;
  /** Project test secrets only. SDD section 30. */
  environment: Record<string, string>;
  timeoutMs: number;
  /**
   * DI-14.41. A preview the caller started while the validator wrote its plan. The pass uses it
   * instead of starting its own, and stops it on every path, the paths that never need it too.
   */
  earlyPreview?: Promise<PreviewHandle>;
  /**
   * DI-15.23. Set when `planText` is the corrected plan of the one correction round: the reasons
   * Factoree rejected the first plan for. A corrected plan that fails again blocks every automated
   * assertion with both reasons.
   */
  rejectedPlanReason?: string;
  /**
   * docs/specs/repository-setup-and-services.md. The accounts of the config. A browser entry with
   * `as` starts signed in as one of them.
   */
  accounts?: readonly AccountConfig[];
  /** Issue #44, DI-21.68. The browser check limits of the repository. Absent takes the defaults. */
  browserLimits?: BrowserLimits;
  /**
   * Issue #44, DI-21.71. The cancellation signal of the activity. When it fires, the pass starts
   * no further assertion, closes a running browser, and rejects with the abort reason.
   */
  signal?: AbortSignal;
  /**
   * docs/specs/by-eye-criteria-and-selector-recheck.md. The criteria a person judges by eye. After
   * the plan runs, the pass captures one screenshot of each route.
   */
  forYourEye?: readonly ForYourEyeCriterion[];
  /**
   * docs/specs/by-eye-criteria-and-selector-recheck.md. Asks the validator once for corrected
   * selectors. Absent: a selector-only failure stays a failure.
   */
  selectorRecheck?: SelectorRecheck;
}

/** docs/specs/by-eye-criteria-and-selector-recheck.md. One browser entry that failed only on its selector, twice. */
export interface SelectorRecheckRequest {
  assertionId: string;
  /** The entry as the plan held it. */
  entry: BrowserPlanEntry;
  failure: BrowserSelectorFailure;
  /** The readable reason of the second failure, redacted. */
  error: string;
  /** The final screenshot of the second run, or null when the driver captured none. */
  screenshot: Uint8Array | null;
  /** The page HTML of the second run, redacted, or null when the driver read none. */
  pageHtml: string | null;
}

/**
 * The answer of the re-check: the text of the file the validator wrote, or null with the reason
 * no file exists.
 */
export interface SelectorRecheckReply {
  text: string | null;
  problem: string | null;
}

/** The one re-check round of a pass. The activity resumes the validator session. */
export type SelectorRecheck = (requests: SelectorRecheckRequest[]) => Promise<SelectorRecheckReply>;

/** Issue #44. How one browser assertion runs. */
export interface BrowserAssertionRun {
  runId: string;
  /** The effective limits of this scenario, `effectiveBrowserLimits` of the remaining pass budget. */
  limits: BrowserLimits;
  /** Issue #44, DI-21.69. `preview.readySelector`. */
  readySelector?: string | undefined;
  signal?: AbortSignal | undefined;
  /** docs/specs/repository-setup-and-services.md. The browser state of a signed-in account. */
  storageState?: string | undefined;
}

/** docs/specs/repository-setup-and-services.md. The longest one sign-in may take. */
const SIGN_IN_TIMEOUT_MS = 60_000;

/** The sign-in steps of an account, with its credentials in the fill values, then its check. */
export const signInStepsOf = (account: AccountConfig): BrowserStep[] => [
  ...account.steps.map((step) =>
    step.action === "fill"
      ? { ...step, value: step.value.replaceAll("{username}", account.username).replaceAll("{password}", account.password) }
      : step,
  ),
  account.check,
];

const MANUAL_REASON = "SDD section 36: this assertion needs a human. Factoree cannot prove it.";

const NO_PLAN_ENTRY_REASON = "The validator produced no check for this assertion.";

const NO_PREVIEW_REASON = (assertionId: string): string =>
  `Assertion "${assertionId}" needs the preview, but the repository configures none. ` +
  "Set an enabled preview block in .factoree/config.yaml.";

const isManualMethod = (method: ValidationAssertion["method"]): boolean =>
  method === "manual" || method === "code_review";

const manualOutcome = (assertion: ValidationAssertion): AssertionOutcome => ({
  assertionId: assertion.id,
  method: assertion.method,
  result: "MANUAL_REQUIRED",
  reason: MANUAL_REASON,
  artifacts: [],
});

const blockedOutcome = (assertion: ValidationAssertion, reason: string, artifacts: EvidenceArtifact[] = []): AssertionOutcome => ({
  assertionId: assertion.id,
  method: assertion.method,
  result: "BLOCKED",
  reason,
  artifacts,
});

const needsPreview = (kind: ReturnType<typeof planKindForMethod>): boolean => kind === "http" || kind === "browser";

const artifactBytes = (metadata: Record<string, unknown>): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(metadata));

const consoleArtifact = (source: string, text: string): EvidenceArtifact => ({
  kind: "console",
  source,
  contentType: "text/plain",
  bytes: new TextEncoder().encode(text),
  metadata: { text },
});

const hash = (redactor: Redactor, value: string): string => {
  // A stable short digest of a redacted body, kept in metadata instead of the raw text, so
  // repeated evidence never leaks output through metadata alone.
  const redacted = redactor.redactText(value);
  let digest = 0;
  for (let index = 0; index < redacted.length; index += 1) {
    digest = (digest * 31 + redacted.charCodeAt(index)) >>> 0;
  }
  return digest.toString(16);
};

/** Runs a `command` or `test` assertion inside the sandbox. Rule 9. */
const executeCommandAssertion = async (
  dependencies: UserValidatorDependencies,
  input: UserValidationInput,
  assertion: ValidationAssertion,
  entry: Extract<ValidationPlanEntry, { kind: "command" }>,
): Promise<AssertionOutcome> => {
  const artifactKind = assertion.method === "test" ? "test-report" : "command-output";
  const source = `command:${assertion.id}`;
  const result = await dependencies.sandbox.exec(input.ref, {
    file: "sh",
    args: ["-c", entry.command.run],
    cwd: input.primaryPath,
    env: input.environment,
    timeoutMs: input.timeoutMs,
  });

  const redactedStdout = dependencies.redactor.redactText(result.stdout);
  const redactedStderr = dependencies.redactor.redactText(result.stderr);
  // SDD section 60. The command text comes from the agent-authored plan, and that session holds
  // Project test secrets. Redact it before it reaches a persisted record or a persisted reason.
  const redactedRun = dependencies.redactor.redactText(entry.command.run);
  const metadata = {
    command: redactedRun,
    exitCode: result.exitCode,
    expectExitCode: entry.command.expectExitCode,
    stdoutHash: hash(dependencies.redactor, result.stdout),
    stderrHash: hash(dependencies.redactor, result.stderr),
    log: `--- stdout ---\n${redactedStdout}\n--- stderr ---\n${redactedStderr}\n`,
  };
  const artifact: EvidenceArtifact = {
    kind: artifactKind,
    source,
    contentType: "text/plain",
    bytes: artifactBytes(metadata),
    metadata,
  };

  const passed = result.exitCode === entry.command.expectExitCode;
  return {
    assertionId: assertion.id,
    method: assertion.method,
    result: passed ? "PASS" : "FAIL",
    reason: passed
      ? `"${redactedRun}" exited with the expected code ${String(entry.command.expectExitCode)}.`
      : `"${redactedRun}" exited with code ${String(result.exitCode)}, expected ${String(entry.command.expectExitCode)}.`,
    artifacts: [artifact],
  };
};

/** Runs a `browser` assertion against the exposed preview. Rule 8. */
export const executeBrowserAssertion = async (
  dependencies: UserValidatorDependencies,
  assertion: ValidationAssertion,
  entry: Extract<ValidationPlanEntry, { kind: "browser" }>,
  handle: PreviewHandle,
  options: BrowserAssertionRun,
): Promise<AssertionOutcome> => (await runBrowserAssertion(dependencies, assertion, entry, handle, options)).outcome;

/** Rule 8, with the driver result, or null when Factoree refused the plan before the browser ran. */
const runBrowserAssertion = async (
  dependencies: UserValidatorDependencies,
  assertion: ValidationAssertion,
  entry: Extract<ValidationPlanEntry, { kind: "browser" }>,
  handle: PreviewHandle,
  options: BrowserAssertionRun,
): Promise<{ outcome: AssertionOutcome; run: BrowserRunResult | null }> => {
  // Defence in depth. The plan parser already rejects a goto path that can leave the preview
  // origin. This control repeats the check, because it must not trust the parser. A refusal is
  // BLOCKED, never a PASS and never a silent skip.
  for (const step of entry.steps) {
    if (step.action !== "goto") continue;
    try {
      resolvePreviewUrl(handle.baseUrl, step.path);
    } catch (error) {
      const message = dependencies.redactor.redactText(
        error instanceof Error ? error.message : String(error),
      );
      return {
        outcome: {
          assertionId: assertion.id,
          method: assertion.method,
          result: "BLOCKED",
          reason: `Factoree refused the browser goto path: ${message}`,
          artifacts: [],
        },
        run: null,
      };
    }
  }

  // docs/specs/proof-pack-and-visual-evidence.md. A plan with more than one interaction step
  // shows a flow, and a screenshot shows only its end, so the driver records a video too.
  const interactionSteps = entry.steps.filter((step) => step.action === "click" || step.action === "fill").length;
  const captureVideo = assertion.evidence.includes("video") || interactionSteps > 1;
  const captureTrace = assertion.evidence.includes("trace");
  // Issue #44, DI-21.70. Each step reaches the worker log as it starts, and a timed-out step as a
  // warning, so an operator sees a slow check while it runs.
  const onStep = (event: BrowserStepEvent): void => {
    const fields = {
      run_id: options.runId,
      step: "user_validate",
      assertion_id: assertion.id,
      step_index: event.index,
      action: event.action,
      selector: event.selector === null ? null : dependencies.redactor.redactText(event.selector),
      limit_ms: event.limitMs,
    };
    if (event.kind === "started") dependencies.logger.info("browser step started", fields);
    else dependencies.logger.warn("browser step timed out", fields);
  };
  const run = await dependencies.browser.run({
    baseUrl: handle.baseUrl,
    steps: entry.steps,
    captureVideo,
    captureTrace,
    timeoutMs: options.limits.scenarioTimeoutMs,
    stepTimeoutMs: options.limits.stepTimeoutMs,
    onStep,
    ...(options.readySelector === undefined ? {} : { readySelector: options.readySelector }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.storageState === undefined ? {} : { storageState: options.storageState }),
  });

  const artifacts: EvidenceArtifact[] = [];
  for (const artifact of run.artifacts) {
    // SDD section 60. The artefact name comes from the agent-authored plan, and that session
    // holds Project test secrets. Redact it before it reaches a persisted record.
    const name = dependencies.redactor.redactText(artifact.name);
    artifacts.push({
      kind: artifact.kind,
      // SDD section 39. Each artefact records its own evidence row. The evidence idempotency key
      // derives from this source, so a run with a named screenshot and the final screenshot must
      // not produce one source twice. The name makes the source unique and keeps it readable.
      source: `browser:${assertion.id}:${artifact.kind}:${name}`,
      contentType: artifact.contentType,
      bytes: artifact.bytes,
      metadata: { assertionId: assertion.id, name },
    });
  }

  const redactedConsole = run.consoleLines.map((line) => dependencies.redactor.redactText(line));
  const consoleMetadata = { assertionId: assertion.id, lines: redactedConsole };
  artifacts.push({
    kind: "console",
    source: `browser:${assertion.id}:console`,
    contentType: "application/json",
    bytes: artifactBytes(consoleMetadata),
    metadata: consoleMetadata,
  });

  const networkMetadata = {
    assertionId: assertion.id,
    entries: run.network.map((entry_) => ({
      method: entry_.method,
      url: dependencies.redactor.redactText(entry_.url),
      status: entry_.status,
    })),
  };
  artifacts.push({
    kind: "network",
    source: `browser:${assertion.id}:network`,
    contentType: "application/json",
    bytes: artifactBytes(networkMetadata),
    metadata: networkMetadata,
  });

  const stepsMetadata = {
    assertionId: assertion.id,
    // docs/specs/browser-network-control.md. A failRequest step makes the error the page shows,
    // so the proof pack must say that Factoree injected it.
    injectedFailure: entry.steps.some((step) => step.action === "failRequest"),
    steps: run.steps.map((step) => ({
      index: step.index,
      action: step.action,
      passed: step.passed,
      detail: dependencies.redactor.redactText(step.detail),
      ...(step.requests === undefined
        ? {}
        : {
            requests: step.requests.map((request) => ({
              method: request.method,
              url: dependencies.redactor.redactText(request.url),
              effect: request.effect,
              autoReleased: request.autoReleased,
              failedWith: request.failedWith,
            })),
          }),
    })),
  };
  artifacts.push({
    kind: "assertion-log",
    source: `browser:${assertion.id}:assertion-log`,
    contentType: "application/json",
    bytes: artifactBytes(stepsMetadata),
    metadata: stepsMetadata,
  });

  const reason = run.passed
    ? `Every step of the browser scenario for "${assertion.id}" passed.`
    : `The browser scenario for "${assertion.id}" failed: ${dependencies.redactor.redactText(run.failureReason ?? "no reason was given.")}`;

  return {
    outcome: {
      assertionId: assertion.id,
      method: assertion.method,
      result: run.passed ? "PASS" : "FAIL",
      reason,
      artifacts,
    },
    run,
  };
};

/**
 * Compares the evidence a frozen assertion requires against the evidence kinds the outcome
 * actually produced. SDD section 37 requires the required kinds to exist, not merely be listed.
 */
const enforceRequiredEvidence = (
  assertion: ValidationAssertion,
  outcome: AssertionOutcome,
): AssertionOutcome => {
  if (outcome.result !== "PASS") return outcome;
  const producedKinds = new Set(outcome.artifacts.map((artifact) => artifact.kind));
  const missing = assertion.evidence.filter((kind) => !producedKinds.has(kind));
  if (missing.length === 0) return outcome;
  return {
    ...outcome,
    result: "FAIL",
    reason:
      `Assertion "${assertion.id}" ("${assertion.statement}") requires the evidence ` +
      `${missing.join(", ")}, which the run did not produce.`,
  };
};

/**
 * Executes the frozen Validation Contract of one Run through a declarative plan. SDD section 36.
 * Returns the results and their evidence artefacts in memory. Persists nothing, starts no agent.
 */
export const runUserValidation = async (
  dependencies: UserValidatorDependencies,
  input: UserValidationInput,
): Promise<UserValidationOutcome> => {
  const early = input.earlyPreview;
  if (early === undefined) return validate(dependencies, input, null);
  // The pass adopts the early preview only when the plan needs it. Otherwise it stops here.
  const adoption = { adopted: false };
  try {
    return await validate(dependencies, input, { preview: early, adoption });
  } finally {
    if (!adoption.adopted) {
      await early.then((handle) => stopPreview(dependencies.sandbox, input.ref, handle)).catch(() => undefined);
    }
  }
};

const validate = async (
  dependencies: UserValidatorDependencies,
  input: UserValidationInput,
  early: { preview: Promise<PreviewHandle>; adoption: { adopted: boolean } } | null,
): Promise<UserValidationOutcome> => {
  const { contract } = input;
  // Issue #44, DI-21.68. The pass budget runs from here, so a later scenario gets what is left.
  const passDeadline = Date.now() + input.timeoutMs;

  // Rule 1. A manual or a code_review assertion needs a human. It runs nothing.
  const manualIds = new Set<string>();
  for (const assertion of contract.assertions) {
    if (isManualMethod(assertion.method)) manualIds.add(assertion.id);
  }

  const automatedAssertions = contract.assertions.filter((assertion) => !manualIds.has(assertion.id));

  // Rule 2. No plan, or an invalid plan, blocks every automated assertion.
  let plan: ValidationPlan | null = null;
  let planFailureReason: string | null = null;
  const corrected = input.rejectedPlanReason !== undefined;
  if (input.planText === null) {
    planFailureReason = corrected
      ? "The validator wrote no corrected Validation Plan."
      : "The validator wrote no Validation Plan.";
  } else {
    try {
      plan = parseValidationPlan(
        input.planText,
        contract,
        (input.accounts ?? []).map((account) => account.name),
      );
    } catch (error) {
      if (error instanceof ValidationPlanInvalidError) {
        planFailureReason = dependencies.redactor.redactText(error.message);
      } else {
        throw error;
      }
    }
  }
  if (planFailureReason !== null && corrected) {
    planFailureReason =
      `Factoree rejected the first Validation Plan: ${input.rejectedPlanReason!} ` +
      `It then rejected the corrected Validation Plan: ${planFailureReason}`;
  }

  const outcomesById = new Map<string, AssertionOutcome>();

  for (const assertion of contract.assertions) {
    if (manualIds.has(assertion.id)) {
      outcomesById.set(assertion.id, manualOutcome(assertion));
    }
  }

  const forYourEye = input.forYourEye ?? [];
  if (planFailureReason !== null) {
    for (const assertion of automatedAssertions) {
      outcomesById.set(assertion.id, blockedOutcome(assertion, planFailureReason));
    }
    const outcomes = contract.assertions.map((assertion) => outcomesById.get(assertion.id)!);
    return {
      ...summarizeUserValidation(outcomes),
      forYourEye: forYourEye.map((item) => ({
        ...item,
        captured: false,
        reason: "Factoree ran no check in this attempt, because it had no Validation Plan it could run.",
      })),
    };
  }

  const planEntries = new Map<string, ValidationPlanEntry>();
  for (const entry of plan!.entries) planEntries.set(entry.assertionId, entry);

  // Rule 3. An assertion the plan does not cover is BLOCKED.
  for (const assertion of automatedAssertions) {
    if (!planEntries.has(assertion.id)) {
      outcomesById.set(assertion.id, blockedOutcome(assertion, NO_PLAN_ENTRY_REASON));
    }
  }

  const pendingAssertions = automatedAssertions.filter((assertion) => !outcomesById.has(assertion.id));

  // Rule 4. Decide whether a preview is needed. A for-your-eye screenshot needs it too.
  const previewRequired =
    forYourEye.length > 0 ||
    pendingAssertions.some((assertion) => {
      const kind = planKindForMethod(assertion.method);
      return needsPreview(kind);
    });

  const previewMisconfigured = input.preview === null || !input.preview.enabled;

  if (previewRequired && previewMisconfigured) {
    for (const assertion of pendingAssertions) {
      const kind = planKindForMethod(assertion.method);
      if (needsPreview(kind)) {
        outcomesById.set(assertion.id, blockedOutcome(assertion, NO_PREVIEW_REASON(assertion.id)));
      }
    }
  }

  const remainingAssertions = pendingAssertions.filter((assertion) => !outcomesById.has(assertion.id));

  let handle: PreviewHandle | null = null;
  // Why the pass has no preview, for a for-your-eye capture that needs one.
  let previewProblem: string | null = previewMisconfigured
    ? "the repository configures no enabled preview in .factoree/config.yaml"
    : null;
  const recheckCandidates: RecheckCandidate[] = [];
  const captures: ForYourEyeCapture[] = [];
  try {
    if (previewRequired && !previewMisconfigured) {
      // Rule 5. Start the preview once, for the whole pass. The log names how long the build and
      // the readiness wait took, because it is the slowest part of a validation of a web app.
      const previewStarted = Date.now();
      try {
        if (early !== null) early.adoption.adopted = true;
        handle = await (early?.preview ??
          startPreview({
            sandbox: dependencies.sandbox,
            ref: input.ref,
            workingDirectory: input.primaryPath,
            preview: input.preview!,
            environment: input.environment,
            probe: dependencies.probe,
            redactor: dependencies.redactor,
          }));
        // With an early preview this is only the wait after the plan, not the whole build.
        dependencies.logger.info("the preview is ready", {
          run_id: input.runId,
          step: "user_validate",
          preview_wait_ms: Date.now() - previewStarted,
          started_early: early !== null,
        });
      } catch (error) {
        if (!(error instanceof PreviewStartError)) throw error;
        const redactedReason = dependencies.redactor.redactText(error.message);
        const redactedLog = dependencies.redactor.redactText(error.log);
        previewProblem = redactedReason;
        let attachedLog = false;
        for (const assertion of remainingAssertions) {
          const kind = planKindForMethod(assertion.method);
          if (!needsPreview(kind)) continue;
          const artifacts: EvidenceArtifact[] = [];
          if (!attachedLog) {
            artifacts.push(consoleArtifact(`preview:${assertion.id}`, redactedLog));
            attachedLog = true;
          }
          outcomesById.set(assertion.id, blockedOutcome(assertion, redactedReason, artifacts));
        }
      }
    }

    // docs/specs/repository-setup-and-services.md. Each account signs in once per pass, so per
    // check sprite, and every entry that names it reuses its browser state.
    const signIns = new Map<string, Promise<BrowserSignInResult>>();
    const signInAs = (name: string): Promise<BrowserSignInResult> => {
      let pending = signIns.get(name);
      if (pending === undefined) {
        const account = (input.accounts ?? []).find((candidate) => candidate.name === name)!;
        pending = dependencies.browser.signIn({
          baseUrl: handle!.baseUrl,
          steps: signInStepsOf(account),
          timeoutMs: Math.min(input.timeoutMs, SIGN_IN_TIMEOUT_MS),
          ...(input.preview?.readySelector === undefined ? {} : { readySelector: input.preview.readySelector }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        signIns.set(name, pending);
      }
      return pending;
    };

    // Rule 6. Execute the entries in contract order.
    for (const assertion of remainingAssertions) {
      // Issue #44, DI-21.71. A stop starts no further assertion. The rejection ends the pass, and
      // the `finally` below stops the preview.
      input.signal?.throwIfAborted();
      if (outcomesById.has(assertion.id)) continue;
      const entry = planEntries.get(assertion.id)!;

      let outcome: AssertionOutcome;
      const assertionStarted = Date.now();
      if (entry.kind === "http") {
        // Rule 7.
        outcome = await executeHttpAssertion({
          assertion,
          request: entry.request,
          baseUrl: handle!.baseUrl,
          fetchImpl: dependencies.fetchImpl,
          redactor: dependencies.redactor,
        });
      } else if (entry.kind === "browser" && entry.as !== undefined && !(await signInAs(entry.as)).signedIn) {
        // docs/specs/repository-setup-and-services.md. A sign-in that fails proves nothing about
        // the criterion. BLOCKED starts no repair, and the reason names the step.
        const failed = (await signInAs(entry.as)) as Extract<BrowserSignInResult, { signedIn: false }>;
        outcome = blockedOutcome(
          assertion,
          `The sign-in of account "${entry.as}" failed at step ${failed.failedStep}: ` +
            dependencies.redactor.redactText(failed.reason),
        );
      } else if (entry.kind === "browser") {
        // Rule 8.
        const signedIn = entry.as === undefined ? undefined : await signInAs(entry.as);
        const storageState = signedIn?.signedIn === true ? signedIn.storageState : undefined;
        // Issue #44, DI-21.68. The fixed limits, or what is left of the pass budget when less. The
        // rerun takes its own limits, so it too fails in about the step limit.
        const browserRun = (): BrowserAssertionRun => ({
          runId: input.runId,
          limits: effectiveBrowserLimits(input.browserLimits ?? DEFAULT_BROWSER_LIMITS, passDeadline - Date.now()),
          readySelector: input.preview?.readySelector,
          signal: input.signal,
          storageState,
        });
        const first = await runBrowserAssertion(dependencies, assertion, entry, handle!, browserRun());
        outcome = enforceRequiredEvidence(assertion, first.outcome);
        // docs/specs/run-recovery.md. A failed browser assertion runs once more in the same check
        // sprite. A different result makes it unstable: not proven, and not worth a repair.
        if (outcome.result === "FAIL") {
          input.signal?.throwIfAborted();
          const second = await runBrowserAssertion(dependencies, assertion, entry, handle!, browserRun());
          const rerun = enforceRequiredEvidence(assertion, second.outcome);
          // docs/specs/by-eye-criteria-and-selector-recheck.md. Both runs failed only on a selector,
          // so the check may be at fault, not the change. It waits for the one re-check round.
          const selectorFailure = second.run?.selectorFailure ?? null;
          if (rerun.result === "FAIL" && (first.run?.selectorFailure ?? null) !== null && selectorFailure !== null) {
            const failed = second.run!;
            const handleNow = handle!;
            recheckCandidates.push({
              assertion,
              request: {
                assertionId: assertion.id,
                entry,
                failure: selectorFailure,
                error: dependencies.redactor.redactText(failed.failureReason ?? "no reason was given."),
                screenshot: failed.artifacts.find((artifact) => artifact.kind === "screenshot" && artifact.name === "final")?.bytes ?? null,
                pageHtml: failed.pageHtml === undefined || failed.pageHtml === null ? null : dependencies.redactor.redactText(failed.pageHtml),
              },
              run: async (corrected) =>
                enforceRequiredEvidence(
                  assertion,
                  (await runBrowserAssertion(dependencies, assertion, corrected, handleNow, browserRun())).outcome,
                ),
            });
          }
          if (rerun.result === "PASS") {
            outcome = {
              ...outcome,
              result: "UNSTABLE",
              reason:
                "The browser check failed once and passed when Factoree ran it again in the same sandbox, " +
                `so Factoree cannot prove it. The failed run said: ${outcome.reason}`,
              artifacts: [...outcome.artifacts, ...rerun.artifacts],
            };
          }
        }
      } else {
        // Rule 9.
        outcome = await executeCommandAssertion(dependencies, input, assertion, entry);
      }

      dependencies.logger.info("assertion executed", {
        run_id: input.runId,
        step: "user_validate",
        assertion_id: assertion.id,
        kind: entry.kind,
        duration_ms: Date.now() - assertionStarted,
      });

      // Rule 10. Enforce the required evidence.
      outcomesById.set(assertion.id, enforceRequiredEvidence(assertion, outcome));
    }

    // docs/specs/by-eye-criteria-and-selector-recheck.md. One re-check round per pass, after every
    // entry ran, so one resumed session corrects every selector-only failure at once.
    if (recheckCandidates.length > 0 && input.selectorRecheck !== undefined) {
      input.signal?.throwIfAborted();
      for (const [id, outcome] of await recheckSelectors(dependencies, input, input.selectorRecheck, recheckCandidates, outcomesById)) {
        outcomesById.set(id, outcome);
      }
    }

    // docs/specs/by-eye-criteria-and-selector-recheck.md. Factoree owns the capture, so no agent
    // writes a check that can fail. A failed capture is a line for the human, never a failure.
    for (const item of forYourEye) {
      input.signal?.throwIfAborted();
      const capture = await captureForYourEye(dependencies, input, item, {
        handle,
        previewProblem,
        signIn: signInAs,
        deadline: passDeadline,
      });
      if (capture.captured) {
        dependencies.logger.info("for-your-eye screenshot captured", { run_id: input.runId, step: "user_validate", criterion_id: item.id });
      } else {
        dependencies.logger.warn("for-your-eye screenshot not captured", {
          run_id: input.runId,
          step: "user_validate",
          criterion_id: item.id,
          reason: capture.reason,
        });
      }
      captures.push(capture);
    }
  } finally {
    // Rule 11. Stop the preview in a finally, whatever happened.
    if (handle !== null) {
      await stopPreview(dependencies.sandbox, input.ref, handle);
    }
  }

  // Rule 12. Summarize in contract order.
  const outcomes = contract.assertions.map((assertion) => outcomesById.get(assertion.id)!);
  return { ...summarizeUserValidation(outcomes), forYourEye: captures };
};

/** A browser entry that waits for the re-check, and the run of its corrected entry. */
interface RecheckCandidate {
  assertion: ValidationAssertion;
  request: SelectorRecheckRequest;
  run: (corrected: BrowserPlanEntry) => Promise<AssertionOutcome>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The corrected entries of the re-check file, or the reason it holds none. */
const correctedEntriesOf = (reply: SelectorRecheckReply): { entries: unknown[] } | { problem: string } => {
  if (reply.text === null) return { problem: reply.problem ?? "the validator wrote no corrected entries" };
  let document: unknown;
  try {
    document = JSON.parse(reply.text);
  } catch {
    return { problem: "the re-check file is not valid JSON" };
  }
  if (!isRecord(document) || !Array.isArray(document["entries"])) {
    return { problem: 'the re-check file holds no "entries" list' };
  }
  return { entries: document["entries"] };
};

/**
 * docs/specs/by-eye-criteria-and-selector-recheck.md. Asks the validator once for corrected
 * selectors, checks each answer against the entry that failed, and runs each accepted one once. A
 * pass is a pass on evidence, and a fail is a real failure. A rejected answer leaves the original
 * failure. The round spends no repair budget, because it runs inside the pass.
 */
const recheckSelectors = async (
  dependencies: UserValidatorDependencies,
  input: UserValidationInput,
  recheck: SelectorRecheck,
  candidates: RecheckCandidate[],
  outcomesById: ReadonlyMap<string, AssertionOutcome>,
): Promise<Map<string, AssertionOutcome>> => {
  const logFields = { run_id: input.runId, step: "user_validate" };
  dependencies.logger.info("selector re-check started", {
    ...logFields,
    assertion_ids: candidates.map((candidate) => candidate.assertion.id),
  });
  let reply: SelectorRecheckReply;
  try {
    reply = await recheck(candidates.map((candidate) => candidate.request));
  } catch (error) {
    // A stop ends the pass. Any other fault of the round leaves each failure as it was.
    input.signal?.throwIfAborted();
    reply = { text: null, problem: `the re-check session failed: ${dependencies.redactor.redactText(error instanceof Error ? error.message : String(error))}` };
  }
  const answer = correctedEntriesOf(reply);
  const results = new Map<string, AssertionOutcome>();
  for (const candidate of candidates) {
    const id = candidate.assertion.id;
    const original = outcomesById.get(id)!;
    const offered =
      "entries" in answer
        ? answer.entries.find((entry) => isRecord(entry) && entry["assertionId"] === id)
        : undefined;
    const checked =
      "problem" in answer
        ? { problem: answer.problem }
        : offered === undefined
          ? { problem: "the validator wrote no corrected entry for it" }
          : checkSelectorCorrection(candidate.request.entry, offered);
    if ("problem" in checked) {
      const problem = dependencies.redactor.redactText(checked.problem);
      dependencies.logger.warn("selector re-check rejected; the failure stands", { ...logFields, assertion_id: id, reason: problem });
      results.set(id, {
        ...original,
        reason: `${original.reason} Factoree asked the validator once to correct the selector, and rejected the answer: ${problem}.`,
      });
      continue;
    }
    input.signal?.throwIfAborted();
    const rerun = await candidate.run(checked.entry);
    dependencies.logger.info("selector re-check finished", { ...logFields, assertion_id: id, result: rerun.result });
    results.set(id, { ...rerun, reason: `After one selector re-check: ${rerun.reason}` });
  }
  return results;
};

/** What a for-your-eye capture needs from the pass. */
interface CaptureContext {
  handle: PreviewHandle | null;
  previewProblem: string | null;
  signIn: (name: string) => Promise<BrowserSignInResult>;
  deadline: number;
}

/**
 * docs/specs/by-eye-criteria-and-selector-recheck.md. Loads one route in the preview, signed in as
 * the first account when the repository defines one, and keeps the screenshot. No interaction
 * step runs before it. A repository ready selector is waited for, so the page has rendered.
 */
const captureForYourEye = async (
  dependencies: UserValidatorDependencies,
  input: UserValidationInput,
  item: ForYourEyeCriterion,
  context: CaptureContext,
): Promise<ForYourEyeCapture> => {
  const failed = (reason: string): ForYourEyeCapture => ({ ...item, captured: false, reason });
  if (context.handle === null) return failed(context.previewProblem ?? "the preview did not start");
  const account = (input.accounts ?? [])[0];
  let storageState: string | undefined;
  if (account !== undefined) {
    const signedIn = await context.signIn(account.name);
    if (!signedIn.signedIn) {
      return failed(
        `the sign-in of account "${account.name}" failed at step ${String(signedIn.failedStep)}: ` +
          dependencies.redactor.redactText(signedIn.reason),
      );
    }
    storageState = signedIn.storageState;
  }
  const readySelector = input.preview?.readySelector;
  const steps: BrowserStep[] = [
    { action: "goto", path: item.route },
    ...(readySelector === undefined ? [] : [{ action: "expectVisible" as const, selector: readySelector }]),
  ];
  const limits = effectiveBrowserLimits(input.browserLimits ?? DEFAULT_BROWSER_LIMITS, context.deadline - Date.now());
  try {
    const run = await dependencies.browser.run({
      baseUrl: context.handle.baseUrl,
      steps,
      captureVideo: false,
      captureTrace: false,
      timeoutMs: limits.scenarioTimeoutMs,
      stepTimeoutMs: limits.stepTimeoutMs,
      ...(readySelector === undefined ? {} : { readySelector }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(storageState === undefined ? {} : { storageState }),
    });
    const screenshot = run.artifacts.find((artifact) => artifact.kind === "screenshot");
    if (!run.passed || screenshot === undefined) {
      return failed(dependencies.redactor.redactText(run.failureReason ?? "the browser returned no screenshot"));
    }
    return {
      ...item,
      captured: true,
      artifact: {
        kind: "screenshot",
        source: forYourEyeSource(item.id),
        contentType: screenshot.contentType,
        bytes: screenshot.bytes,
        metadata: {
          forYourEye: item.id,
          statement: item.statement,
          route: item.route,
          ...(account === undefined ? {} : { signedInAs: account.name }),
        },
      },
    };
  } catch (error) {
    input.signal?.throwIfAborted();
    return failed(dependencies.redactor.redactText(error instanceof Error ? error.message : String(error)));
  }
};
