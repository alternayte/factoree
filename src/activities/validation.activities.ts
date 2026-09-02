import { Context } from "@temporalio/activity";
import type { Logger } from "~/telemetry/logger.js";
import { metrics } from "~/telemetry/metrics.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { ValidationContractStore } from "~/domain/validation/validation-contract-store.js";
import type { ValidationCriterion } from "~/domain/validation/validation-contract-builder.js";
import { buildValidationContract } from "~/domain/validation/validation-contract-builder.js";
import { validateValidationContract } from "~/domain/validation/validation-contract.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import type { AgentRunner, AgentRunnerRegistry, AgentSessionRef } from "~/domain/runs/agent-runner.js";
import { UnknownAgentRunnerError } from "~/domain/runs/agent-runner.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import type { AgentExecutionRepository } from "~/domain/runs/agent-execution.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";
import type { Redactor } from "~/telemetry/redaction.js";
import type { BrowserDriver } from "~/domain/validation/browser-driver.js";
import type { HttpValidationFetch } from "~/domain/validation/http-validation.js";
import type { ReadinessProbe } from "~/domain/runs/preview.js";
import type { PreviewConfig } from "~/domain/runs/project-runtime-config.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { registerProjectSecrets } from "~/domain/projects/redaction-loader.js";
import { buildUserValidatorInput } from "~/domain/validation/user-validator-input.js";
import { runUserValidation } from "~/domain/validation/user-validator.js";
import type { AssertionResult } from "~/domain/validation/validation-result.js";
import type { EvidencePersistence } from "~/activities/evidence.activities.js";
import { attachRunnerEnvironment } from "~/domain/projects/runner-credentials.js";

export interface BuildValidationContractActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  workItem: string;
  goal: string;
  acceptanceCriteria: ValidationCriterion[];
  humanAssertions: string[];
}

export interface BuildValidationContractActivityOutput {
  /** `needs_input` means SDD section 9 item 5 is not met, and implementation must not start. */
  status: "ready" | "needs_input";
  /** The frozen contract hash, or null when nothing froze. */
  sha256: string | null;
  document: string;
  assertionCount: number;
  /** AT-10. The moment the contract froze, so a test can compare it with the Implementer start. */
  frozenAt: string | null;
  question: { id: string; question: string } | null;
  /** The line Factoree posts to Linear. */
  summary: string;
}

/**
 * The dependencies `userValidate` alone needs. They are grouped apart from
 * `ValidationActivityDependencies` because `buildValidationContract` needs none of them, and a
 * caller that wires only that activity must not have to supply the rest.
 */
export interface UserValidationActivityDependencies {
  sandbox: Sandbox;
  runners: AgentRunnerRegistry;
  executions: AgentExecutionRepository;
  secrets: SecretStore;
  redactor: Redactor;
  browser: BrowserDriver;
  fetchImpl: HttpValidationFetch;
  probe: ReadinessProbe;
  evidencePersistence: EvidencePersistence;
}

export interface ValidationActivityDependencies {
  contracts: ValidationContractStore;
  runs: RunRepository;
  logger: Logger;
  /** Present whenever this activity set also serves `userValidate`. SDD section 63. */
  userValidation?: UserValidationActivityDependencies;
}

export interface UserValidateActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  runnerName: string;
  spriteId: string;
  adapter: string;
  workspacePath: string;
  primaryPath: string;
  goal: string;
  preview: PreviewConfig | null;
  timeoutMs: number;
  /** The user validation pass. The first pass is 1, and a repair raises it. */
  attempt: number;
}

export interface UserValidateActivityOutput {
  passed: boolean;
  results: Array<{ assertionId: string; result: AssertionResult; reason: string }>;
  /** True when at least one assertion is FAIL. Only then can a repair help. */
  hasFailure: boolean;
  /** True when at least one assertion is MANUAL_REQUIRED. */
  hasManual: boolean;
  /** True when at least one assertion is BLOCKED. */
  hasBlocked: boolean;
  summary: string;
  /** The failing assertions, formatted for `ImplementActivityInput.repairFindings`. */
  failures: string[];
  /** AT-17. The runner session identifier of this validator pass. */
  sessionId: string;
  /**
   * SDD section 47. The exposed preview base URL of this pass, or null when the pass started no
   * preview. The Proof Pack names it. It is reachable only while the sandbox lives.
   */
  previewUrl: string | null;
}

/** The interval between two heartbeats. See `agent.activities.ts` for the same rule. */
const VALIDATOR_HEARTBEAT_INTERVAL_MS = 30_000;

/** The time the cancel path waits for the live session to appear. */
const VALIDATOR_SESSION_LOOKUP_TIMEOUT_MS = 60_000;

/** The delay between two lookups of the live session. */
const VALIDATOR_SESSION_LOOKUP_INTERVAL_MS = 100;

/** The time one call of `cancel` on the runner gets before the activity gives up on it. */
const VALIDATOR_CANCEL_TIMEOUT_MS = 30_000;

interface RunnerWithActiveSession {
  activeSession(runId: string): AgentSessionRef | undefined;
}

const activeValidatorSessionOf = (runner: AgentRunner, runId: string): AgentSessionRef | undefined => {
  const candidate = runner as Partial<RunnerWithActiveSession>;
  if (typeof candidate.activeSession !== "function") return undefined;
  return candidate.activeSession(runId);
};

const QUESTION_ID = "VAL-Q-1";

const QUESTION =
  "What observable behavior proves this work is done? Factoree needs at least one assertion a " +
  "person or a machine can check, for example a page state, an HTTP response, or a command exit " +
  "code. Factoree must not invent product behavior, so it cannot state this itself.";

const summaryOf = (assertions: number, sha256: string): string =>
  `Factoree froze the Validation Contract with ${assertions} ` +
  `${assertions === 1 ? "assertion" : "assertions"}. Version ${sha256.slice(0, 12)}. ` +
  "It cannot change while this Run implements the work.";

/** SDD section 63 names this file. */
export const createValidationActivities = (dependencies: ValidationActivityDependencies) => ({
  async buildValidationContract(
    input: BuildValidationContractActivityInput,
  ): Promise<BuildValidationContractActivityOutput> {
    const started = Date.now();
    const labels = { tenant_id: input.tenantId, project_id: input.projectId };

    try {
      // SDD section 25. A frozen contract is the contract of this Run. A retry, and any later
      // call, must return that contract and must never rebuild it. See controller decision 7.
      const existing = await dependencies.contracts.findByRun(input.tenantId, input.runId);
      if (existing !== null) {
        // A repeat write here repairs a Run row that an interrupted earlier attempt left without
        // the hash: the contract froze, but the process stopped, or a retry ran, before the
        // hash reached the Run. The write is idempotent, so a repeat call is safe.
        await dependencies.runs.setValidationContractVersion(
          input.tenantId,
          input.runId,
          existing.sha256,
        );
        dependencies.logger.info("validation contract already frozen", {
          tenant_id: input.tenantId,
          project_id: input.projectId,
          run_id: input.runId,
          step: "build_validation_contract",
          status: "ready",
        });
        return {
          status: "ready",
          sha256: existing.sha256,
          document: existing.document,
          assertionCount: existing.assertions.length,
          frozenAt: existing.createdAt.toISOString(),
          question: null,
          summary: summaryOf(existing.assertions.length, existing.sha256),
        };
      }

      const built = buildValidationContract({
        runId: input.runId,
        workItem: input.workItem,
        goal: input.goal,
        acceptanceCriteria: input.acceptanceCriteria,
        humanAssertions: input.humanAssertions,
      });

      // SDD section 9 item 5. No observable success assertion exists, so the readiness gate
      // fails and nothing freezes. See controller decision 3.
      if (built.contract.assertions.length === 0) {
        dependencies.logger.info("validation contract needs input", {
          tenant_id: input.tenantId,
          project_id: input.projectId,
          run_id: input.runId,
          step: "build_validation_contract",
          status: "needs_input",
        });
        return {
          status: "needs_input",
          sha256: null,
          document: built.document,
          assertionCount: 0,
          frozenAt: null,
          question: { id: QUESTION_ID, question: QUESTION },
          summary:
            "Factoree cannot define success for this Work Item. It needs one observable " +
            "assertion before it can start implementation.",
        };
      }

      // SDD section 9 item 9. Only a valid contract freezes. A defect in the builder must fail
      // the activity here, not reach the store.
      validateValidationContract(built.contract);

      const stored = await dependencies.contracts.save({
        tenantId: input.tenantId,
        runId: input.runId,
        contract: built.contract,
        sha256: built.sha256,
        document: built.document,
      });

      await dependencies.runs.setValidationContractVersion(
        input.tenantId,
        input.runId,
        stored.sha256,
      );

      dependencies.logger.info("validation contract frozen", {
        tenant_id: input.tenantId,
        project_id: input.projectId,
        run_id: input.runId,
        step: "build_validation_contract",
        status: "ready",
        assertion_count: stored.assertions.length,
        validation_contract_version: stored.sha256,
      });

      return {
        status: "ready",
        sha256: stored.sha256,
        document: stored.document,
        assertionCount: stored.assertions.length,
        frozenAt: stored.createdAt.toISOString(),
        question: null,
        summary: summaryOf(stored.assertions.length, stored.sha256),
      };
    } finally {
      metrics.validationContractDuration.observe(labels, (Date.now() - started) / 1000);
    }
  },

  /**
   * SDD section 36. Runs a fresh User Validator session against the frozen Validation Contract,
   * then persists every result and every evidence artefact. The activity input carries the
   * goal, the frozen contract, the repository path, the plan path, and the preview URL, and it
   * carries no Implementer transcript, no Implementer summary, and no Reviewer finding. No
   * field of `UserValidateActivityInput` could hold one, which is the strongest form of that
   * guarantee.
   */
  async userValidate(input: UserValidateActivityInput): Promise<UserValidateActivityOutput> {
    const started = Date.now();
    const labels = { tenant_id: input.tenantId, project_id: input.projectId };

    try {
      const uv = dependencies.userValidation;
      if (uv === undefined) {
        throw new Error(
          "userValidate requires ValidationActivityDependencies.userValidation, and none was " +
            "supplied.",
        );
      }

      // Step 1. SDD section 60: every Project secret reaches the redactor before any output is
      // captured.
      await registerProjectSecrets(
        uv.redactor,
        uv.secrets,
        input.tenantId,
        input.projectId,
        dependencies.logger,
      );

      // Step 2. A Run with no frozen contract cannot reach this activity.
      const storedContract = await dependencies.contracts.findByRun(input.tenantId, input.runId);
      if (storedContract === null) {
        throw new Error(
          `No frozen Validation Contract exists for run "${input.runId}". User validation ` +
            "must not start before the contract freezes.",
        );
      }

      // Step 3. Controller decision 6: the validator role denies `writePrimaryWorktree`. The
      // `role` control is not a Project override; SDD section 29 permits exactly one, staging
      // read, and this is the role of the session instead.
      const actionPolicy = buildActionPolicy({ role: "validator" });

      const ref = { id: input.spriteId, adapter: input.adapter, workspacePath: input.workspacePath };
      // SDD section 30. The runner credential is attached again here, because the attachment lives
      // in the worker process that made it, and another worker can run this activity.
      await attachRunnerEnvironment(
        uv.sandbox,
        ref,
        uv.secrets,
        input.tenantId,
        input.projectId,
      );
      const validationDirectory = `${input.workspacePath}/validation`;

      // Step 4. The scratch directory the validator session works from. It is never the
      // primary worktree.
      await uv.sandbox.exec(ref, {
        file: "mkdir",
        args: ["-p", validationDirectory],
      });

      // Step 5. The prompt needs only the exposed base URL, and an address does not need a
      // running server. `sandbox.exposeService` is the SDD section 37 step 3 call: it computes
      // the URL a client outside the sandbox uses for an already configured port, without
      // starting or touching the preview process. `runUserValidation` remains the one owner of
      // the preview lifetime; it starts the actual process later and stops it in its own
      // `finally`, at this same URL, because `exposeService` is a pure address computation over
      // one fixed port.
      const needsPreview = storedContract.assertions.some(
        (assertion) => assertion.method === "browser" || assertion.method === "http",
      );
      let previewBaseUrl: string | null = null;
      if (needsPreview && input.preview !== null && input.preview.enabled) {
        const port = Number(new URL(input.preview.readyUrl).port);
        if (Number.isFinite(port) && port !== 0 && !Number.isNaN(port)) {
          try {
            const service = await uv.sandbox.exposeService(ref, port);
            previewBaseUrl = service.url;
          } catch {
            // The prompt states that no preview exists. `runUserValidation` makes its own
            // attempt below and blocks each affected assertion with its own honest reason,
            // for example the Fly sandbox adapter's recorded Phase 2 limitation.
            previewBaseUrl = null;
          }
        }
      }

      // The Project test secrets marked for injection. Same rule as the Implementer, SDD
      // section 30.
      const descriptors = await uv.secrets.list(input.tenantId, input.projectId);
      const projectTestSecrets: Record<string, string> = {};
      for (const descriptor of descriptors) {
        // A credential of another kind reaches its carrier by its own path, never this map.
        if (descriptor.kind !== "test" || !descriptor.injectIntoImplementer) continue;
        const value = await uv.secrets.get(input.tenantId, input.projectId, descriptor.name);
        if (value !== null) projectTestSecrets[descriptor.name] = value;
      }

      const planPath = `${validationDirectory}/plan.json`;
      const validatorInput = buildUserValidatorInput({
        goal: input.goal,
        validationContract: storedContract.document,
        primaryRepositoryPath: input.primaryPath,
        planPath,
        previewBaseUrl,
        actionPolicy,
        projectTestSecrets,
      });

      // Step 6. The fresh validator session. It never receives the Implementer transcript, the
      // Implementer summary, or a Reviewer finding, because this activity never receives them
      // either.
      // SDD section 49. An unregistered validator runner is a fault in `.factoree/config.yaml`,
      // not a fault in the infrastructure. `RunConfigurationError` routes the Run to
      // `FAILED_CONFIGURATION`, so an operator can repair the name.
      let runner: AgentRunner;
      try {
        runner = uv.runners.get(input.runnerName);
      } catch (error) {
        if (!(error instanceof UnknownAgentRunnerError)) throw error;
        throw new RunConfigurationError(
          `The Project configures the validator runner "${input.runnerName}", which is not registered. ` +
            `Registered runners: ${uv.runners.names().join(", ")}. ` +
            "Repair `validator_runner` in `.factoree/config.yaml`.",
        );
      }
      const context = Context.current();

      const heartbeat = setInterval(() => {
        context.heartbeat();
      }, VALIDATOR_HEARTBEAT_INTERVAL_MS);

      let running = true;
      let pendingTimer: NodeJS.Timeout | null = null;

      const cancelLiveSession = async (): Promise<void> => {
        const deadline = Date.now() + VALIDATOR_SESSION_LOOKUP_TIMEOUT_MS;
        while (running && Date.now() < deadline) {
          const session = activeValidatorSessionOf(runner, input.runId);
          if (session !== undefined) {
            try {
              await Promise.race([
                runner.cancel(session),
                new Promise((_resolve, reject) =>
                  setTimeout(
                    () => reject(new Error("the runner did not answer the cancel")),
                    VALIDATOR_CANCEL_TIMEOUT_MS,
                  ).unref(),
                ),
              ]);
            } catch (error) {
              dependencies.logger.error("the cancellation of the User Validator session failed", {
                tenant_id: input.tenantId,
                run_id: input.runId,
                runner: runner.name,
                error: String(error),
              });
            }
            return;
          }
          await new Promise((resolve) => {
            pendingTimer = setTimeout(resolve, VALIDATOR_SESSION_LOOKUP_INTERVAL_MS);
            pendingTimer.unref();
          });
        }
      };

      const onCancel = (): void => {
        void cancelLiveSession();
      };
      if (context.cancellationSignal.aborted) onCancel();
      else context.cancellationSignal.addEventListener("abort", onCancel, { once: true });

      let sessionResult;
      try {
        sessionResult = await runner.run({
          runId: input.runId,
          tenantId: input.tenantId,
          role: "validator",
          sandbox: uv.sandbox,
          ref,
          workingDirectory: validationDirectory,
          // The session reads its model and its provider timeouts from the repository.
          repositoryPath: input.primaryPath,
          prompt: validatorInput.prompt,
          promptVersion: validatorInput.promptVersion,
          environment: validatorInput.environment,
          actionPolicy,
          timeoutMs: input.timeoutMs,
        });
      } finally {
        running = false;
        clearInterval(heartbeat);
        if (pendingTimer !== null) clearTimeout(pendingTimer);
        context.cancellationSignal.removeEventListener("abort", onCancel);
      }

      // Step 7. One AgentExecution row per validator pass.
      await uv.executions.record({
        tenantId: input.tenantId,
        runId: input.runId,
        role: "validator",
        runner: runner.name,
        model: null,
        sessionRef: sessionResult.session.sessionId,
        promptVersion: validatorInput.promptVersion,
        durationMs: sessionResult.durationMs,
        finalResult: {
          completed: sessionResult.completed,
          exitCode: sessionResult.exitCode,
          cancelled: sessionResult.cancelled,
          summary: sessionResult.summary,
        },
        idempotencyKey: `run:${input.runId}:validator:${input.attempt}`,
      });

      // Step 8. A missing or unreadable plan gives `planText = null`.
      let planResult = await uv.sandbox.exec(ref, { file: "cat", args: [planPath] });

      // A session that answers without writing its plan blocks every automated assertion, and
      // the Run then proves nothing although the change may be correct. A measured session wrote
      // the file on one pass and not on the next, from the same prompt. One reminder costs a few
      // seconds and recovers the pass, so the session is asked once more before the Run gives up.
      if (planResult.exitCode !== 0) {
        dependencies.logger.warn("the validator wrote no plan, asking once more", {
          tenant_id: input.tenantId,
          project_id: input.projectId,
          run_id: input.runId,
          step: "user_validate",
        });
        const reminder = await runner.resume(sessionResult.session, {
          prompt:
            `You wrote no Validation Plan. Write the plan now, as one JSON document, to ${planPath}. ` +
            "Write the file and nothing else. Do not answer with the plan in a message.",
          timeoutMs: input.timeoutMs,
        });
        void reminder;
        planResult = await uv.sandbox.exec(ref, { file: "cat", args: [planPath] });
      }

      const planText = planResult.exitCode === 0 ? planResult.stdout : null;

      // Step 9. Executes the plan against the frozen contract. `ValidationContract.version`
      // stays the literal `1` of SDD section 24, so the stored row's numeric `version` column
      // must be dropped here rather than passed through.
      const frozenContract: ValidationContract = {
        version: 1,
        runId: storedContract.runId,
        workItem: storedContract.workItem,
        goal: storedContract.goal,
        assertions: storedContract.assertions,
      };
      const outcome = await runUserValidation(
        {
          sandbox: uv.sandbox,
          browser: uv.browser,
          fetchImpl: uv.fetchImpl,
          probe: uv.probe,
          redactor: uv.redactor,
          logger: dependencies.logger,
        },
        {
          runId: input.runId,
          tenantId: input.tenantId,
          ref,
          primaryPath: input.primaryPath,
          contract: frozenContract,
          preview: input.preview,
          planText,
          environment: projectTestSecrets,
          timeoutMs: input.timeoutMs,
        },
      );

      // Step 10. Persists every outcome, keyed on the row identifier of the matching stored
      // assertion, never on the contract-level identifier.
      const rowIdByAssertionId = new Map(
        storedContract.assertions.map((assertion) => [assertion.id, assertion.rowId]),
      );
      for (const assertionOutcome of outcome.outcomes) {
        const validationAssertionId = rowIdByAssertionId.get(assertionOutcome.assertionId);
        if (validationAssertionId === undefined) {
          throw new Error(
            `The outcome names assertion "${assertionOutcome.assertionId}", which the frozen ` +
              "contract does not contain.",
          );
        }
        await uv.evidencePersistence.persistAssertionOutcome({
          tenantId: input.tenantId,
          runId: input.runId,
          validationAssertionId,
          outcome: assertionOutcome,
          attempt: input.attempt,
        });
      }

      dependencies.logger.info("user validation finished", {
        tenant_id: input.tenantId,
        project_id: input.projectId,
        run_id: input.runId,
        step: "user_validate",
        passed: outcome.passed,
      });

      return {
        passed: outcome.passed,
        results: outcome.outcomes.map((assertionOutcome) => ({
          assertionId: assertionOutcome.assertionId,
          result: assertionOutcome.result,
          reason: assertionOutcome.reason,
        })),
        hasFailure: outcome.outcomes.some((assertionOutcome) => assertionOutcome.result === "FAIL"),
        hasManual: outcome.outcomes.some(
          (assertionOutcome) => assertionOutcome.result === "MANUAL_REQUIRED",
        ),
        hasBlocked: outcome.outcomes.some((assertionOutcome) => assertionOutcome.result === "BLOCKED"),
        summary: outcome.summary,
        failures: outcome.failures,
        sessionId: sessionResult.session.sessionId,
        previewUrl: previewBaseUrl,
      };
    } finally {
      metrics.validationDuration.observe(labels, (Date.now() - started) / 1000);
    }
  },
});
