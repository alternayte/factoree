import { Context } from "@temporalio/activity";
import type { Logger } from "~/telemetry/logger.js";
import { metrics } from "~/telemetry/metrics.js";
import type { ValidationContractStore } from "~/domain/validation/validation-contract-store.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import type { AgentRunner, AgentRunnerRegistry, AgentSessionRef } from "~/domain/runs/agent-runner.js";
import { UnknownAgentRunnerError } from "~/domain/runs/agent-runner.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import type { AgentExecutionRepository } from "~/domain/runs/agent-execution.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { registerProjectSecrets } from "~/domain/projects/redaction-loader.js";
import { buildReviewerInput } from "~/domain/review/reviewer-input.js";
import { captureSourceDiff } from "~/domain/review/source-diff.js";
import {
  parseReviewReport,
  ReviewReportInvalidError,
  type ReviewFinding,
} from "~/domain/review/review-report.js";
import { decideReview, failureLine } from "~/domain/review/blocking.js";
import type { ReviewFindingStore } from "~/domain/review/review-finding-store.js";

/**
 * SDD section 40. The Reviewer runs in a fresh session, against the goal, the frozen Validation
 * Contract, the Context Contract, the constraints, the source diff, the deterministic
 * verification result, and the user-validation evidence. No field of this interface can hold an
 * Implementer transcript or an Implementer summary. An absent field is the guarantee, and this
 * interface adds none.
 */
export interface ReviewActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  runnerName: string;
  spriteId: string;
  adapter: string;
  workspacePath: string;
  primaryPath: string;
  baseSha: string;
  goal: string;
  contextContract: string | null;
  constraints: string[];
  verificationSummary: string;
  validationEvidence: string[];
  repositoryInstructions: string;
  timeoutMs: number;
  /** The review pass this attempt belongs to. The first pass is 1. SDD section 42. */
  attempt: number;
}

export interface ReviewActivityOutput {
  /** Factoree's own decision, from `decideReview`. It never comes from the agent verdict. */
  passed: boolean;
  verdict: "pass" | "fail";
  findingCount: number;
  blockingCount: number;
  summary: string;
  failures: string[];
  sessionId: string;
  /** False when the report is absent or fails to parse. Controller decision 7 owns this path. */
  reportUsable: boolean;
  reportProblem: string | null;
}

export interface ReviewActivityDependencies {
  sandbox: Sandbox;
  runners: AgentRunnerRegistry;
  executions: AgentExecutionRepository;
  secrets: SecretStore;
  redactor: Redactor;
  contracts: ValidationContractStore;
  reviewFindings: ReviewFindingStore;
  logger: Logger;
}

/** The interval between two heartbeats. See `agent.activities.ts` for the same rule. */
const REVIEWER_HEARTBEAT_INTERVAL_MS = 30_000;

/** The time the cancel path waits for the live session to appear. */
const REVIEWER_SESSION_LOOKUP_TIMEOUT_MS = 60_000;

/** The delay between two lookups of the live session. */
const REVIEWER_SESSION_LOOKUP_INTERVAL_MS = 100;

/** The time one call of `cancel` on the runner gets before the activity gives up on it. */
const REVIEWER_CANCEL_TIMEOUT_MS = 30_000;

interface RunnerWithActiveSession {
  activeSession(runId: string): AgentSessionRef | undefined;
}

const activeReviewerSessionOf = (runner: AgentRunner, runId: string): AgentSessionRef | undefined => {
  const candidate = runner as Partial<RunnerWithActiveSession>;
  if (typeof candidate.activeSession !== "function") return undefined;
  return candidate.activeSession(runId);
};

const NO_REPORT = "The Reviewer wrote no report.";

/**
 * Redacts the free-text fields of one finding. The Reviewer session receives the Project test
 * secrets in its environment, so a value it echoes into `id`, `requirement`, `evidence`, or
 * `description` must never reach a persisted row, a returned failure line, or a log line. SDD
 * section 60. This must run only after `decideReview` has already used the unredacted finding
 * to decide blocking, because a redaction can change the text of `evidence` and must never
 * change which finding blocks. The redaction returns a new object, so the `finding` inside
 * `decision` stays untouched.
 */
const redactFinding = (redactor: Redactor, finding: ReviewFinding): ReviewFinding => ({
  ...finding,
  id: redactor.redactText(finding.id),
  requirement: redactor.redactText(finding.requirement),
  evidence: redactor.redactText(finding.evidence),
  description: redactor.redactText(finding.description),
});

/** SDD section 63 names this file. */
export const createReviewActivities = (dependencies: ReviewActivityDependencies) => ({
  /**
   * SDD section 40 and section 43. Runs a fresh Reviewer session against the frozen Validation
   * Contract and the diff of this Run, then persists every finding through `decideReview`. The
   * activity input carries no Implementer transcript and no Implementer summary. Factoree
   * decides `passed`; the agent `verdict` never decides it. See SDD principle P-01.
   */
  async review(input: ReviewActivityInput): Promise<ReviewActivityOutput> {
    const started = Date.now();
    const labels = { tenant_id: input.tenantId, project_id: input.projectId };

    try {
      // Step 1. SDD section 60: every Project secret reaches the redactor before any output is
      // captured. This must run before the diff capture below.
      await registerProjectSecrets(
        dependencies.redactor,
        dependencies.secrets,
        input.tenantId,
        input.projectId,
        dependencies.logger,
      );

      // Step 2. A Run with no frozen contract cannot reach this activity.
      const storedContract = await dependencies.contracts.findByRun(input.tenantId, input.runId);
      if (storedContract === null) {
        throw new Error(
          `No frozen Validation Contract exists for run "${input.runId}". Review must not start ` +
            "before the contract freezes.",
        );
      }

      // Step 3. Controller decision: the reviewer role denies `writePrimaryWorktree`. The
      // Reviewer writes only into the review directory, never into the primary worktree.
      const actionPolicy = buildActionPolicy({ role: "reviewer" });

      const ref = { id: input.spriteId, adapter: input.adapter, workspacePath: input.workspacePath };
      const reviewDirectory = `${input.workspacePath}/review`;

      // Step 4. The scratch directory the reviewer session works from. It is never the primary
      // worktree.
      await dependencies.sandbox.exec(ref, {
        file: "mkdir",
        args: ["-p", reviewDirectory],
      });

      // Step 5. A `SourceDiffError` is a real fault, so it must propagate rather than be caught
      // here.
      const diff = await captureSourceDiff(
        { sandbox: dependencies.sandbox, redactor: dependencies.redactor },
        { ref, primaryPath: input.primaryPath, baseSha: input.baseSha },
      );

      // Step 6. The Project test secrets marked for injection. Same rule as the Implementer,
      // SDD section 30.
      const descriptors = await dependencies.secrets.list(input.tenantId, input.projectId);
      const projectTestSecrets: Record<string, string> = {};
      for (const descriptor of descriptors) {
        if (!descriptor.injectIntoImplementer) continue;
        const value = await dependencies.secrets.get(input.tenantId, input.projectId, descriptor.name);
        if (value !== null) projectTestSecrets[descriptor.name] = value;
      }

      // Defect 3 fix. The report path carries the attempt number, so a stale report from an
      // earlier attempt can never be read as this attempt's report. The prompt below and the
      // `cat` call at step 11 both read this one value.
      const reportPath = `${reviewDirectory}/report-${input.attempt}.json`;
      const reviewerInput = buildReviewerInput({
        goal: input.goal,
        validationContract: storedContract.document,
        contextContract: input.contextContract,
        constraints: input.constraints,
        sourceDiff: diff.text,
        diffTruncated: diff.truncated,
        changedFiles: diff.changedFiles,
        verificationSummary: input.verificationSummary,
        validationEvidence: input.validationEvidence,
        repositoryInstructions: input.repositoryInstructions,
        reportPath,
        actionPolicy,
        projectTestSecrets,
      });

      // Step 8. SDD section 49. An unregistered reviewer runner is a fault in
      // `.factoree/config.yaml`, not a fault in the infrastructure. `RunConfigurationError`
      // routes the Run to `FAILED_CONFIGURATION`, so an operator can repair the name.
      let runner: AgentRunner;
      try {
        runner = dependencies.runners.get(input.runnerName);
      } catch (error) {
        if (!(error instanceof UnknownAgentRunnerError)) throw error;
        throw new RunConfigurationError(
          `The Project configures the reviewer runner "${input.runnerName}", which is not registered. ` +
            `Registered runners: ${dependencies.runners.names().join(", ")}. ` +
            "Repair `reviewer_runner` in `.factoree/config.yaml`.",
        );
      }
      const context = Context.current();

      const heartbeat = setInterval(() => {
        context.heartbeat();
      }, REVIEWER_HEARTBEAT_INTERVAL_MS);

      let running = true;
      let pendingTimer: NodeJS.Timeout | null = null;

      const cancelLiveSession = async (): Promise<void> => {
        const deadline = Date.now() + REVIEWER_SESSION_LOOKUP_TIMEOUT_MS;
        while (running && Date.now() < deadline) {
          const session = activeReviewerSessionOf(runner, input.runId);
          if (session !== undefined) {
            try {
              await Promise.race([
                runner.cancel(session),
                new Promise((_resolve, reject) =>
                  setTimeout(
                    () => reject(new Error("the runner did not answer the cancel")),
                    REVIEWER_CANCEL_TIMEOUT_MS,
                  ).unref(),
                ),
              ]);
            } catch (error) {
              dependencies.logger.error("the cancellation of the Reviewer session failed", {
                tenant_id: input.tenantId,
                run_id: input.runId,
                runner: runner.name,
                error: String(error),
              });
            }
            return;
          }
          await new Promise((resolve) => {
            pendingTimer = setTimeout(resolve, REVIEWER_SESSION_LOOKUP_INTERVAL_MS);
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
        // Step 9. A fresh session, every attempt. Factoree never resumes a Reviewer session and
        // never carries a session reference between attempts.
        sessionResult = await runner.run({
          runId: input.runId,
          tenantId: input.tenantId,
          role: "reviewer",
          sandbox: dependencies.sandbox,
          ref,
          workingDirectory: reviewDirectory,
          prompt: reviewerInput.prompt,
          promptVersion: reviewerInput.promptVersion,
          environment: reviewerInput.environment,
          actionPolicy,
          timeoutMs: input.timeoutMs,
        });
      } finally {
        running = false;
        clearInterval(heartbeat);
        if (pendingTimer !== null) clearTimeout(pendingTimer);
        context.cancellationSignal.removeEventListener("abort", onCancel);
      }

      // Step 10. One AgentExecution row per review pass.
      await dependencies.executions.record({
        tenantId: input.tenantId,
        runId: input.runId,
        role: "reviewer",
        runner: runner.name,
        model: null,
        sessionRef: sessionResult.session.sessionId,
        promptVersion: reviewerInput.promptVersion,
        durationMs: sessionResult.durationMs,
        finalResult: {
          completed: sessionResult.completed,
          exitCode: sessionResult.exitCode,
          cancelled: sessionResult.cancelled,
          summary: sessionResult.summary,
        },
        idempotencyKey: `run:${input.runId}:reviewer:${input.attempt}`,
      });

      // Defect 4 fix. A session that did not complete, or that was cancelled, proves nothing.
      // A cancel here is the underlying runner reporting that the live Reviewer session stopped
      // early. `OpenCodeRunner` returns `completed: false` on a timeout. Either way, a report
      // file can still exist on disk from a partial write, and it must never decide the Run. A
      // human stop reaches this same code path, because the activity here handles cancellation
      // itself and returns a normal result rather than throwing, but the workflow already checks
      // `stopRequested` before it reads `reportUsable`, and it takes the stop path first, so this
      // unusable-report result never surfaces as `REVIEW_UNAVAILABLE` on an ordinary human stop.
      if (!sessionResult.completed || sessionResult.cancelled) {
        return {
          passed: false,
          verdict: "fail",
          findingCount: 0,
          blockingCount: 0,
          summary: "",
          failures: [],
          sessionId: sessionResult.session.sessionId,
          reportUsable: false,
          reportProblem: sessionResult.cancelled
            ? "The Reviewer session was cancelled."
            : "The Reviewer session did not complete.",
        };
      }

      // Step 11. A missing or unreadable report gives `reportText = null`.
      const reportResult = await dependencies.sandbox.exec(ref, {
        file: "cat",
        args: [reportPath],
      });
      const reportText = reportResult.exitCode === 0 ? reportResult.stdout : null;

      // Step 12. An unusable report is not a repair path. It persists nothing.
      let report;
      if (reportText === null) {
        return {
          passed: false,
          verdict: "fail",
          findingCount: 0,
          blockingCount: 0,
          summary: "",
          failures: [],
          sessionId: sessionResult.session.sessionId,
          reportUsable: false,
          reportProblem: NO_REPORT,
        };
      }
      try {
        report = parseReviewReport(reportText);
      } catch (error) {
        if (!(error instanceof ReviewReportInvalidError)) throw error;
        return {
          passed: false,
          verdict: "fail",
          findingCount: 0,
          blockingCount: 0,
          summary: "",
          failures: [],
          sessionId: sessionResult.session.sessionId,
          reportUsable: false,
          // A parse error can quote the offending input, for example an unparsable JSON
          // fragment or an unrecognised value, so it must pass through the redactor too.
          reportProblem: dependencies.redactor.redactText(error.message),
        };
      }

      // Step 13. `ValidationContract.version` stays the literal `1` of SDD section 24, so the
      // stored row's numeric `version` column must be dropped here rather than passed through.
      const frozenContract: ValidationContract = {
        version: 1,
        runId: storedContract.runId,
        workItem: storedContract.workItem,
        goal: storedContract.goal,
        assertions: storedContract.assertions,
      };
      const decision = decideReview({
        report,
        contract: frozenContract,
        changedFiles: diff.changedFiles,
      });

      // Step 14. Every finding is persisted, blocking and non-blocking. Controller decision 17
      // owns this. `decideReview` already decided `blocking` above, on the unredacted finding,
      // so redacting here cannot change which finding blocks. Only the values that leave this
      // activity are redacted: the persisted row, the returned failure lines below, and the log
      // line at step 15.
      for (const item of decision.decisions) {
        const redacted = redactFinding(dependencies.redactor, item.finding);
        await dependencies.reviewFindings.record({
          tenantId: input.tenantId,
          runId: input.runId,
          attempt: input.attempt,
          verdict: report.verdict,
          findingKey: redacted.id,
          severity: redacted.severity,
          category: redacted.category,
          requirement: redacted.requirement,
          evidence: redacted.evidence,
          description: redacted.description,
          blocking: item.blocking,
          // `item.reason` is plain text `decideReview` built from the unredacted finding, and a
          // non-blocking reason can quote `requirement` or `evidence` verbatim, so it must pass
          // through the redactor too.
          decisionReason: dependencies.redactor.redactText(item.reason),
        });
      }

      dependencies.logger.info("review finished", {
        tenant_id: input.tenantId,
        project_id: input.projectId,
        run_id: input.runId,
        step: "review",
        verdict: report.verdict,
        finding_count: decision.decisions.length,
        blocking_count: decision.blocking.length,
      });

      // Step 16. `passed` comes from `decideReview`, never from the agent verdict. `failures` is
      // rebuilt from the redacted finding, because `decision.failures` was built from the
      // unredacted finding and must never reach the next Implementer prompt.
      const redactedFailures = decision.blocking.map((item) =>
        failureLine({ ...item, finding: redactFinding(dependencies.redactor, item.finding) }),
      );
      return {
        passed: decision.passed,
        verdict: report.verdict,
        findingCount: decision.decisions.length,
        blockingCount: decision.blocking.length,
        summary: decision.summary,
        failures: redactedFailures,
        sessionId: sessionResult.session.sessionId,
        reportUsable: true,
        reportProblem: null,
      };
    } finally {
      metrics.reviewDuration.observe(labels, (Date.now() - started) / 1000);
    }
  },
});
