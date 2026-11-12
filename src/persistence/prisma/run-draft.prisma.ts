import type { FactoreePrismaClient } from "./client.js";
import { FOLLOW_UP_STATUSES } from "~/domain/runs/run-recovery.js";
import {
  NOT_CHECKED_REASON,
  type DraftFacts,
  type DraftRequest,
  type DraftSubject,
  type RunDraftStore,
} from "~/domain/runs/run-draft.js";

/**
 * docs/specs/draft-of-failed-run.md. The facts that decide a draft request, read from what the
 * run stored. Every query carries the tenant. SDD section 52.
 */
export class PrismaRunDraftStore implements RunDraftStore {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async facts(tenantId: string, runId: string): Promise<DraftFacts | null> {
    const run = await this.prisma.run.findFirst({
      where: { tenantId, id: runId },
      select: { id: true, status: true, failureReason: true, failureMessage: true, pullRequestUrl: true, lastPatchAttempt: true },
    });
    if (run === null) return null;
    const where = { tenantId, runId };
    const [patches, targetCount, assertions, results, findings, reviewers] = await Promise.all([
      // The patch itself can be large, so only its presence is read here.
      this.prisma.run.count({ where: { tenantId, id: runId, lastPatchBase64: { not: null } } }),
      this.prisma.runTarget.count({ where }),
      this.prisma.validationAssertion.findMany({
        where: { tenantId, validationContract: { runId } },
        orderBy: { assertionKey: "asc" },
        select: { assertionKey: true, statement: true },
      }),
      this.prisma.validationAssertionResult.findMany({ where, select: { assertionKey: true, attempt: true, result: true, reason: true } }),
      this.prisma.reviewFinding.findMany({ where, orderBy: [{ attempt: "asc" }, { findingKey: "asc" }] }),
      this.prisma.agentSession.findMany({ where: { ...where, role: "reviewer" }, select: { attempt: true, outcome: true } }),
    ]);
    const hasPatch = patches > 0;
    // DI-21.76. A run from before the attempt column names its newest attempt with any record.
    const patchAttempt = !hasPatch
      ? null
      : (run.lastPatchAttempt ??
        Math.max(1, ...results.map((row) => row.attempt), ...findings.map((row) => row.attempt), ...reviewers.map((row) => row.attempt)));
    const ofPatch = findings.filter((finding) => finding.attempt === patchAttempt);
    return {
      runId: run.id,
      status: run.status,
      failureReason: run.failureReason,
      failureMessage: run.failureMessage,
      pullRequestUrl: run.pullRequestUrl,
      hasPatch,
      patchAttempt,
      targetCount,
      // DI-21.80. Each frozen assertion with its result for the attempt of the last patch.
      assertions: assertions.map((assertion) => {
        const result = results.find((row) => row.assertionKey === assertion.assertionKey && row.attempt === patchAttempt);
        return {
          key: assertion.assertionKey,
          statement: assertion.statement,
          result: result?.result ?? "BLOCKED",
          reason: result?.reason ?? NOT_CHECKED_REASON,
        };
      }),
      findings: ofPatch.map((finding) => ({
        key: finding.findingKey,
        severity: finding.severity,
        category: finding.category,
        evidence: finding.evidence,
        description: finding.description,
        blocking: finding.blocking,
      })),
      // DI-21.80. A finished reviewer session, or a finding, of that attempt. A review whose report
      // Factoree could not use proved nothing.
      reviewed:
        run.failureReason !== "REVIEW_UNAVAILABLE" &&
        (ofPatch.length > 0 || reviewers.some((session) => session.attempt === patchAttempt && session.outcome === "finished")),
    };
  }

  async subject(tenantId: string, runId: string): Promise<DraftSubject | null> {
    const run = await this.prisma.run.findFirst({
      where: { tenantId, id: runId },
      select: {
        workItemTitle: true,
        workItemUrl: true,
        waitedMs: true,
        repairCount: true,
        product: { select: { repairMaxAttempts: true } },
        targets: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { repository: { select: { id: true, fullName: true, defaultBranch: true, githubInstallationId: true } } },
        },
      },
    });
    if (run === null) return null;
    const repository = run.targets[0]?.repository ?? null;
    return {
      workItemTitle: run.workItemTitle ?? "",
      workItemUrl: run.workItemUrl,
      waitedMs: run.waitedMs,
      repairLimit: Math.max(run.product.repairMaxAttempts, run.repairCount),
      target:
        repository === null
          ? null
          : {
              repositoryId: repository.id,
              fullName: repository.fullName,
              defaultBranch: repository.defaultBranch,
              githubInstallationId: repository.githubInstallationId,
            },
    };
  }

  async recordRequest(tenantId: string, runId: string, request: DraftRequest, at: Date): Promise<void> {
    await this.prisma.run.updateMany({
      where: { tenantId, id: runId },
      data: { draftRequestedAt: at, draftSource: request.source, draftRequestedBy: request.by },
    });
  }

  /**
   * Writes DRAFT_PUBLISHED on a failed run. The failure reason, the message and the end time stay,
   * because the checks still failed. A retry finds DRAFT_PUBLISHED and writes it again.
   */
  async markPublished(tenantId: string, runId: string): Promise<boolean> {
    const updated = await this.prisma.run.updateMany({
      where: { tenantId, id: runId, status: { in: [...FOLLOW_UP_STATUSES, "DRAFT_PUBLISHED"] } },
      data: { status: "DRAFT_PUBLISHED" },
    });
    return updated.count > 0;
  }
}
