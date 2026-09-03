import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import { guardAgainstForbiddenMaterial } from "~/domain/runs/implementer-input.js";
import { attachRunnerEnvironment } from "~/domain/projects/runner-credentials.js";
import type { EvidenceStore } from "~/domain/evidence/evidence.js";
import { canonicalEvidenceHash } from "~/domain/evidence/evidence.js";
import type { VerificationCommand } from "~/domain/runs/project-runtime-config.js";
import type { VerificationCheckResult } from "~/domain/runs/verification.js";
import { runVerification } from "~/domain/runs/verification.js";
import { registerProjectSecrets } from "~/domain/projects/redaction-loader.js";
import { metrics } from "~/telemetry/metrics.js";

export interface VerificationActivityDependencies {
  sandbox: Sandbox;
  evidence: EvidenceStore;
  secrets: SecretStore;
  redactor: Redactor;
  logger: Logger;
}

export interface VerifyActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  spriteId: string;
  adapter: string;
  workspacePath: string;
  primaryPath: string;
  commands: VerificationCommand[];
  timeoutMs: number;
  /** The ordinal of this verification pass. The first pass is 1, and a repair raises it. */
  attempt: number;
}

export interface VerifyActivityOutput {
  passed: boolean;
  checks: VerificationCheckResult[];
  /** A short text an operator and a repair attempt can both read. */
  summary: string;
  /** The failing checks, formatted for `ImplementActivityInput.repairFindings`. */
  failures: string[];
}

/**
 * The text one failing check contributes to the repair attempt. It carries the name, the exact
 * command, the exit code, and the retained log, so the Implementer acts on evidence rather than
 * on a claim.
 */
const describeFailure = (check: VerificationCheckResult): string =>
  [
    `Verification check "${check.name}" failed with exit code ${check.exitCode}.`,
    `Command: ${check.command}`,
    check.timedOut ? "The command reached its timeout." : "",
    check.log ?? "",
  ]
    .filter((line) => line !== "")
    .join("\n");

export const createVerificationActivities = (dependencies: VerificationActivityDependencies) => ({
  /**
   * SDD section 35. Runs every configured command from a clean shell, records the exact result
   * of each one, and reports whether the implementation passed. No agent claim reaches this
   * function, so a false claim cannot change the outcome.
   */
  async verify(input: VerifyActivityInput): Promise<VerifyActivityOutput> {
    // SDD section 60: every Project secret must reach the redactor before any output is
    // captured. A verification command prints build output, which can hold one.
    await registerProjectSecrets(
      dependencies.redactor,
      dependencies.secrets,
      input.tenantId,
      input.projectId,
      dependencies.logger,
    );

    // SDD section 30: a non-production test secret reaches a command only when the operator
    // marked it. Every other Project secret stays out of the shell.
    const descriptors = await dependencies.secrets.list(input.tenantId, input.projectId);
    const environment: Record<string, string> = {};
    for (const descriptor of descriptors) {
      // A credential of another kind reaches its carrier by its own path, never this map.
      if (descriptor.kind !== "test" || !descriptor.injectIntoImplementer) continue;
      const value = await dependencies.secrets.get(input.tenantId, input.projectId, descriptor.name);
      if (value !== null) environment[descriptor.name] = value;
    }

    // SDD section 30. The runner credential is attached again here, because the attachment lives
    // in the worker process that made it, and another worker can run this activity.
    await attachRunnerEnvironment(
      dependencies.sandbox,
      { id: input.spriteId, adapter: input.adapter, workspacePath: input.workspacePath },
      dependencies.secrets,
      input.tenantId,
      input.projectId,
    );

    // SDD section 30. The implementer, the user validator, and the reviewer all reject forbidden
    // material before their session starts. A verification command runs in the same sandbox, so
    // it needs the same guard.
    guardAgainstForbiddenMaterial(environment);

    const startedAt = Date.now();
    const outcome = await runVerification({
      sandbox: dependencies.sandbox,
      ref: { id: input.spriteId, adapter: input.adapter, workspacePath: input.workspacePath },
      workingDirectory: input.primaryPath,
      commands: input.commands,
      environment,
      timeoutMs: input.timeoutMs,
      redactor: dependencies.redactor,
    });

    // SDD section 39. One immutable row per check. The idempotency key carries the attempt, so
    // a Temporal retry of this activity writes nothing new and a repair pass writes its own row.
    for (const check of outcome.checks) {
      await dependencies.evidence.record({
        tenantId: input.tenantId,
        runId: input.runId,
        validationAssertionId: null,
        kind: "deterministic_check",
        source: `verify:${check.name}`,
        sha256: canonicalEvidenceHash({
          name: check.name,
          command: check.command,
          exitCode: check.exitCode,
          stdoutSha256: check.stdoutSha256,
          stderrSha256: check.stderrSha256,
        }),
        // SDD section 35 requires the stdout hash and the stderr hash separately, and SDD
        // section 39 requires one artifact hash. Both live on the row.
        metadata: {
          name: check.name,
          command: check.command,
          startedAt: check.startedAt,
          endedAt: check.endedAt,
          exitCode: check.exitCode,
          stdoutSha256: check.stdoutSha256,
          stderrSha256: check.stderrSha256,
          timedOut: check.timedOut,
          durationMs: check.durationMs,
          passed: check.passed,
          attempt: input.attempt,
          // The retained, redacted log of SDD section 35. A passing check retains none.
          log: check.log,
        },
        idempotencyKey: `run:${input.runId}:verify:${input.attempt}:${check.name}`,
      });
    }

    metrics.verificationDuration.observe(
      { tenant_id: input.tenantId, project_id: input.projectId },
      (Date.now() - startedAt) / 1000,
    );

    const failed = outcome.checks.filter((check) => !check.passed);
    const summary = outcome.passed
      ? `Deterministic verification passed. ${outcome.checks.length} of ${outcome.checks.length} checks exited 0.`
      : `Deterministic verification failed. ${failed.length} of ${outcome.checks.length} checks did not exit 0: ` +
        `${failed.map((check) => check.name).join(", ")}.`;

    dependencies.logger.info("verification finished", {
      tenant_id: input.tenantId,
      project_id: input.projectId,
      run_id: input.runId,
      passed: outcome.passed,
      checks: outcome.checks.length,
      failed: failed.length,
      attempt: input.attempt,
      step: "verify",
    });

    return { passed: outcome.passed, checks: outcome.checks, summary, failures: failed.map(describeFailure) };
  },
});
