import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";
import type { AgentSessionPort } from "~/domain/runs/ports.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { FactoreeDecision } from "~/domain/runs/factoree-decision.js";
import { metrics } from "~/telemetry/metrics.js";
import {
  DRAFT_OFFER,
  DRAFT_OPTION,
  decideDraft,
  renderDraftWarning,
  type RunDraftStore,
} from "~/domain/runs/run-draft.js";

export interface DraftActivityDependencies {
  drafts: RunDraftStore;
  runs: RunRepository;
  agentSession: AgentSessionPort;
  /** The clone URL base of the install. */
  repositoryBaseUrl: () => Promise<string>;
  redactor: Redactor;
  logger: Logger;
}

/** What the draft workflow publishes, once the run qualifies. */
export interface DraftPlan {
  kind: "ready";
  sessionId: string;
  productId: string;
  issueId: string | null;
  repositoryId: string;
  repositorySlug: string;
  repositoryBaseUrl: string;
  baseBranch: string;
  baseSha: string;
  githubInstallationId: string;
  workItemTitle: string;
  workItemUrl: string | null;
  /** The warning block that starts the pull request body. */
  warning: string;
  /** DI-21.76. The attempt whose check sprite received the patch. */
  patchAttempt: number;
  reviewed: boolean;
  reviewPasses: number;
  reviewVerdict: "pass" | "fail";
  repairCount: number;
  repairLimit: number;
  autonomyLevel: string;
  waitedMs: number;
  decisions: FactoreeDecision[];
}

export type PrepareDraftOutput =
  | { kind: "refused"; sessionId: string | null; reason: string }
  | { kind: "published"; sessionId: string; pullRequestUrl: string }
  | DraftPlan;

/** docs/specs/draft-of-failed-run.md. The activities of the draft workflow of one failed run. */
export const createDraftActivities = (dependencies: DraftActivityDependencies) => ({
  /**
   * Decides the request again inside the workflow, from the stored facts, and reads what the
   * publication needs. The delegation decided it before the start, and the run can change between.
   */
  async prepareDraft(input: { tenantId: string; runId: string }): Promise<PrepareDraftOutput> {
    const run = await dependencies.runs.findById(input.tenantId, input.runId);
    const facts = await dependencies.drafts.facts(input.tenantId, input.runId);
    if (run === null || facts === null) return { kind: "refused", sessionId: null, reason: `No run ${input.runId} exists.` };
    const sessionId = run.linearAgentSessionId;
    const decision = decideDraft(facts);
    if (decision.kind === "refused") return { kind: "refused", sessionId, reason: decision.reason };
    if (decision.kind === "published") return { kind: "published", sessionId, pullRequestUrl: decision.pullRequestUrl };
    const subject = await dependencies.drafts.subject(input.tenantId, input.runId);
    if (subject?.target == null || run.baseSha === null || facts.patchAttempt === null) {
      return {
        kind: "refused",
        sessionId,
        reason: "This run recorded no target repository or base SHA, so Factoree cannot publish its patch as a draft.",
      };
    }
    const blocking = facts.findings.some((finding) => finding.blocking);
    return {
      kind: "ready",
      sessionId,
      productId: run.productId,
      issueId: run.linearIssueId,
      repositoryId: subject.target.repositoryId,
      repositorySlug: subject.target.fullName,
      repositoryBaseUrl: await dependencies.repositoryBaseUrl(),
      baseBranch: subject.target.defaultBranch,
      baseSha: run.baseSha,
      githubInstallationId: subject.target.githubInstallationId,
      workItemTitle: subject.workItemTitle,
      workItemUrl: subject.workItemUrl,
      warning: dependencies.redactor.redactText(renderDraftWarning(facts)),
      patchAttempt: facts.patchAttempt,
      reviewed: facts.reviewed,
      reviewPasses: facts.reviewed ? 1 : 0,
      reviewVerdict: blocking ? "fail" : "pass",
      repairCount: run.repairCount,
      repairLimit: subject.repairLimit,
      autonomyLevel: run.autonomyLevel,
      waitedMs: subject.waitedMs,
      decisions: run.decisions,
    };
  },

  /**
   * Writes DRAFT_PUBLISHED once the draft pull request exists. The failure reason and message
   * stay, and the Linear issue state does not move.
   */
  async completeDraft(input: { tenantId: string; runId: string; productId: string }): Promise<void> {
    const marked = await dependencies.drafts.markPublished(input.tenantId, input.runId);
    if (marked) metrics.runsDraftPublished.inc({ tenant_id: input.tenantId, product_id: input.productId });
    dependencies.logger.info("run draft published", {
      tenant_id: input.tenantId,
      product_id: input.productId,
      run_id: input.runId,
      step: "publish_draft",
      status: marked ? "DRAFT_PUBLISHED" : "unchanged",
    });
  },

  /**
   * After the failure post of a run, offers the draft with Linear's `select` signal and one option,
   * when a request would start it now (DI-21.77).
   */
  async offerDraft(input: { tenantId: string; runId: string; sessionId: string }): Promise<void> {
    const facts = await dependencies.drafts.facts(input.tenantId, input.runId);
    if (facts === null || decideDraft(facts).kind !== "qualifies") return;
    await dependencies.agentSession.elicit(input.sessionId, DRAFT_OFFER, [DRAFT_OPTION]);
  },
});
