import type { PreviewConfig } from "~/domain/runs/project-runtime-config.js";
import {
  startPreview,
  stopPreview,
  PreviewStartError,
  type PreviewHandle,
  type ReadinessProbe,
} from "~/domain/runs/preview.js";
import {
  parseValidationPlan,
  ValidationPlanInvalidError,
  planKindForMethod,
  type ValidationPlan,
  type ValidationPlanEntry,
} from "~/domain/validation/validation-plan.js";
import type {
  AssertionOutcome,
  EvidenceArtifact,
  UserValidationOutcome,
} from "~/domain/validation/validation-result.js";
import { summarizeUserValidation } from "~/domain/validation/validation-result.js";
import { executeHttpAssertion, type HttpValidationFetch } from "~/domain/validation/http-validation.js";
import type { BrowserDriver } from "~/domain/validation/browser-driver.js";
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
}

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
  const metadata = {
    command: entry.command.run,
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
      ? `"${entry.command.run}" exited with the expected code ${String(entry.command.expectExitCode)}.`
      : `"${entry.command.run}" exited with code ${String(result.exitCode)}, expected ${String(entry.command.expectExitCode)}.`,
    artifacts: [artifact],
  };
};

/** Runs a `browser` assertion against the exposed preview. Rule 8. */
const executeBrowserAssertion = async (
  dependencies: UserValidatorDependencies,
  assertion: ValidationAssertion,
  entry: Extract<ValidationPlanEntry, { kind: "browser" }>,
  handle: PreviewHandle,
  timeoutMs: number,
): Promise<AssertionOutcome> => {
  const captureVideo = assertion.evidence.includes("video");
  const captureTrace = assertion.evidence.includes("trace");
  const run = await dependencies.browser.run({
    baseUrl: handle.baseUrl,
    steps: entry.steps,
    captureVideo,
    captureTrace,
    timeoutMs,
  });

  const artifacts: EvidenceArtifact[] = [];
  for (const artifact of run.artifacts) {
    artifacts.push({
      kind: artifact.kind,
      source: `browser:${assertion.id}:${artifact.kind}`,
      contentType: artifact.contentType,
      bytes: artifact.bytes,
      metadata: { assertionId: assertion.id, name: artifact.name },
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
    steps: run.steps.map((step) => ({
      index: step.index,
      action: step.action,
      passed: step.passed,
      detail: dependencies.redactor.redactText(step.detail),
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
    assertionId: assertion.id,
    method: assertion.method,
    result: run.passed ? "PASS" : "FAIL",
    reason,
    artifacts,
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
  const { contract } = input;

  // Rule 1. A manual or a code_review assertion needs a human. It runs nothing.
  const manualIds = new Set<string>();
  for (const assertion of contract.assertions) {
    if (isManualMethod(assertion.method)) manualIds.add(assertion.id);
  }

  const automatedAssertions = contract.assertions.filter((assertion) => !manualIds.has(assertion.id));

  // Rule 2. No plan, or an invalid plan, blocks every automated assertion.
  let plan: ValidationPlan | null = null;
  let planFailureReason: string | null = null;
  if (input.planText === null) {
    planFailureReason = "The validator wrote no Validation Plan.";
  } else {
    try {
      plan = parseValidationPlan(input.planText, contract);
    } catch (error) {
      if (error instanceof ValidationPlanInvalidError) {
        planFailureReason = dependencies.redactor.redactText(error.message);
      } else {
        throw error;
      }
    }
  }

  const outcomesById = new Map<string, AssertionOutcome>();

  for (const assertion of contract.assertions) {
    if (manualIds.has(assertion.id)) {
      outcomesById.set(assertion.id, manualOutcome(assertion));
    }
  }

  if (planFailureReason !== null) {
    for (const assertion of automatedAssertions) {
      outcomesById.set(assertion.id, blockedOutcome(assertion, planFailureReason));
    }
    const outcomes = contract.assertions.map((assertion) => outcomesById.get(assertion.id)!);
    return summarizeUserValidation(outcomes);
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

  // Rule 4. Decide whether a preview is needed.
  const previewRequired = pendingAssertions.some((assertion) => {
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
  try {
    if (previewRequired && !previewMisconfigured) {
      // Rule 5. Start the preview once, for the whole pass.
      try {
        handle = await startPreview({
          sandbox: dependencies.sandbox,
          ref: input.ref,
          workingDirectory: input.primaryPath,
          preview: input.preview!,
          environment: input.environment,
          probe: dependencies.probe,
          redactor: dependencies.redactor,
        });
      } catch (error) {
        if (!(error instanceof PreviewStartError)) throw error;
        const redactedReason = dependencies.redactor.redactText(error.message);
        const redactedLog = dependencies.redactor.redactText(error.log);
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

    // Rule 6. Execute the entries in contract order.
    for (const assertion of remainingAssertions) {
      if (outcomesById.has(assertion.id)) continue;
      const entry = planEntries.get(assertion.id)!;

      let outcome: AssertionOutcome;
      if (entry.kind === "http") {
        // Rule 7.
        outcome = await executeHttpAssertion({
          assertion,
          request: entry.request,
          baseUrl: handle!.baseUrl,
          fetchImpl: dependencies.fetchImpl,
          redactor: dependencies.redactor,
        });
      } else if (entry.kind === "browser") {
        // Rule 8.
        outcome = await executeBrowserAssertion(
          dependencies,
          assertion,
          entry,
          handle!,
          input.timeoutMs,
        );
      } else {
        // Rule 9.
        outcome = await executeCommandAssertion(dependencies, input, assertion, entry);
      }

      // Rule 10. Enforce the required evidence.
      outcomesById.set(assertion.id, enforceRequiredEvidence(assertion, outcome));
    }
  } finally {
    // Rule 11. Stop the preview in a finally, whatever happened.
    if (handle !== null) {
      await stopPreview(dependencies.sandbox, input.ref, handle);
    }
  }

  // Rule 12. Summarize in contract order.
  const outcomes = contract.assertions.map((assertion) => outcomesById.get(assertion.id)!);
  return summarizeUserValidation(outcomes);
};
