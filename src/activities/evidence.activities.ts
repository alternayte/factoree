import { ApplicationFailure } from "@temporalio/activity";
import type { EvidenceStore } from "~/domain/evidence/evidence.js";
import type { EvidenceStorage } from "~/domain/evidence/evidence-storage.js";
import type { ValidationResultStore } from "~/domain/validation/validation-result-store.js";
import type { AssertionOutcome, EvidenceArtifact } from "~/domain/validation/validation-result.js";
import type { Logger } from "~/telemetry/logger.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { ContextContractStore } from "~/domain/context/context-contract-store.js";
import type { ValidationContractStore } from "~/domain/validation/validation-contract-store.js";
import type { ReviewFindingStore } from "~/domain/review/review-finding-store.js";
import type { AgentSessionPort } from "~/domain/runs/ports.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { registerProjectSecrets } from "~/domain/products/redaction-loader.js";
import {
  hashProofPack,
  renderProofPack,
  type ProofPackAssertion,
  type ProofPackCheck,
  type ProofPackEvidenceRef,
  type ProofPackRouting,
} from "~/domain/evidence/proof-pack.js";

export interface EvidencePersistenceDependencies {
  evidence: EvidenceStore;
  results: ValidationResultStore;
  storage: EvidenceStorage;
  logger: Logger;
}

export interface PersistAssertionOutcomeInput {
  tenantId: string;
  runId: string;
  /** The database identifier of the assertion row, from the contract store. */
  validationAssertionId: string;
  outcome: AssertionOutcome;
  attempt: number;
}

export interface EvidencePersistence {
  persistAssertionOutcome(input: PersistAssertionOutcomeInput): Promise<void>;
}

/** The file extension of every content type an evidence artefact carries today. */
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/webm": "webm",
  "video/mp4": "mp4",
  "application/zip": "zip",
  "application/json": "json",
  "text/plain": "txt",
};

/** Reads the extension of a content type. An unknown type gets `bin`, never an empty suffix. */
const extensionOf = (contentType: string): string => {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSION_BY_CONTENT_TYPE[mediaType] ?? "bin";
};

/** Replaces every character a file name must not hold. */
const safeSegment = (value: string): string =>
  value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");

/**
 * Builds the storage file name of one artefact. `artifact.source` holds a colon and carries no
 * extension, so it is not a file name directly. `source` is also the part of the evidence
 * idempotency key that tells two artefacts of one assertion and one kind apart, for example a
 * named screenshot against the driver's own `final` screenshot. The storage name must agree, so
 * it derives from the full `source`, not from the assertion key and the kind alone. Every colon
 * becomes a dash, and the content type gives the extension.
 */
export const storageNameOf = (assertionKey: string, artifact: EvidenceArtifact): string => {
  const base = safeSegment(`${assertionKey}-${artifact.source}`);
  return `${base.length > 0 ? base : "artifact"}.${extensionOf(artifact.contentType)}`;
};

/**
 * SDD section 63 requires this file to exist, because a Temporal workflow must never carry an
 * evidence byte through a workflow payload. `userValidate` calls this function in process, so a
 * screenshot, a video, and a trace stay inside the activity that produced them.
 */
export const createEvidencePersistence = (
  dependencies: EvidencePersistenceDependencies,
): EvidencePersistence => ({
  /**
   * Stores every artefact of one assertion outcome, then writes the one immutable result row.
   * A retry that repeats the same `(runId, attempt, assertionKey, source)` writes nothing new,
   * because both the evidence store and the result store are idempotent on their own key.
   */
  async persistAssertionOutcome(input: PersistAssertionOutcomeInput): Promise<void> {
    for (const artifact of input.outcome.artifacts) {
      const stored = await dependencies.storage.put({
        tenantId: input.tenantId,
        runId: input.runId,
        name: storageNameOf(input.outcome.assertionId, artifact),
        contentType: artifact.contentType,
        bytes: artifact.bytes,
      });

      await dependencies.evidence.record({
        tenantId: input.tenantId,
        runId: input.runId,
        validationAssertionId: input.validationAssertionId,
        kind: artifact.kind,
        source: artifact.source,
        sha256: stored.sha256,
        storageRef: stored.storageRef,
        // SDD section 42. A repair produces a second artefact for the same assertion. The row
        // must therefore name its attempt, exactly as a deterministic check row does. Without it
        // the Proof Pack cannot tell a failed attempt's artefact from the passing one.
        metadata: { ...artifact.metadata, attempt: input.attempt },
        idempotencyKey:
          `run:${input.runId}:validation:${input.attempt}:` +
          `${input.outcome.assertionId}:${artifact.source}`,
      });
    }

    await dependencies.results.record({
      tenantId: input.tenantId,
      runId: input.runId,
      validationAssertionId: input.validationAssertionId,
      assertionKey: input.outcome.assertionId,
      result: input.outcome.result,
      reason: input.outcome.reason,
      attempt: input.attempt,
    });

    dependencies.logger.info("assertion outcome persisted", {
      tenant_id: input.tenantId,
      run_id: input.runId,
      assertion_key: input.outcome.assertionId,
      result: input.outcome.result,
      attempt: input.attempt,
      step: "user_validate",
    });
  },
});

export interface ProofPackActivityDependencies {
  runs: RunRepository;
  products: ProductRegistry;
  repositories: RepositoryRegistry;
  contextContracts: ContextContractStore;
  validationContracts: ValidationContractStore;
  validationResults: ValidationResultStore;
  evidence: EvidenceStore;
  reviewFindings: ReviewFindingStore;
  agentSession: AgentSessionPort;
  secrets: SecretStore;
  redactor: Redactor;
  logger: Logger;
}

export interface PublishProofPackActivityInput {
  runId: string;
  tenantId: string;
  productId: string;
  sessionId: string;
  workItem: { title: string; url: string | null };
  pullRequestUrl: string;
  commitSha: string;
  patchSha256: string;
  baseSha: string;
  changedFiles: string[];
  patchByteLength: number;
  previewUrl: string | null;
  repairCount: number;
  repairLimit: number;
  reviewVerdict: "pass" | "fail";
  reviewPasses: number;
  /**
   * SDD section 42. The attempt number of the LAST Reviewer session. A passing review reports no
   * finding and therefore writes no row, so the stored rows cannot name this attempt. Only the
   * caller knows it, and without it a repaired blocker of an earlier attempt is reported as open.
   */
  reviewAttempt: number;
  /** docs/specs/autonomy-levels.md. The level of the Run, and the caps that applied. */
  autonomyLevel: string;
  autonomyReasons: string[];
  /** docs/specs/check-isolation.md. Changed files that define a check. */
  checkDefiningFiles: string[];
}

export interface PublishProofPackActivityOutput {
  sha256: string;
  /** The number of assertions the Proof Pack mapped to evidence. */
  assertionCount: number;
  /** The number of non-blocking findings it reported as a known limitation. */
  limitationCount: number;
  postedAt: string;
}

/** Reads one number out of evidence metadata. An absent value becomes -1, never a silent 0. */
const metadataNumber = (metadata: Record<string, unknown>, key: string): number =>
  typeof metadata[key] === "number" ? metadata[key] : -1;

const metadataText = (metadata: Record<string, unknown>, key: string): string =>
  typeof metadata[key] === "string" ? metadata[key] : "";

/**
 * SDD section 47. Builds one Proof Pack from the persisted state of one Run, records its hash,
 * and posts it as the Linear final response. It reads recorded facts only. No agent claim and no
 * workflow-carried summary decides what it reports.
 */
export const createProofPackActivities = (dependencies: ProofPackActivityDependencies) => ({
  async publishProofPack(
    input: PublishProofPackActivityInput,
  ): Promise<PublishProofPackActivityOutput> {
    // SDD section 60. Every Project secret reaches the redactor before any text is built. A
    // persisted reason can carry one, because an agent wrote it.
    await registerProjectSecrets(
      dependencies.redactor,
      dependencies.secrets,
      input.tenantId,
      input.productId,
      dependencies.logger,
    );

    const contract = await dependencies.validationContracts.findByRun(input.tenantId, input.runId);
    if (contract === null) {
      throw ApplicationFailure.nonRetryable(
        `Run ${input.runId} has no frozen Validation Contract, so no Proof Pack can prove it.`,
        "PROOF_PACK_INPUT_MISSING",
      );
    }
    const contextContract = await dependencies.contextContracts.findByRun(
      input.tenantId,
      input.runId,
    );
    const resultRows = await dependencies.validationResults.listForRun(input.tenantId, input.runId);
    const evidenceRows = await dependencies.evidence.listForRun(input.tenantId, input.runId);
    const findingRows = await dependencies.reviewFindings.listForRun(input.tenantId, input.runId);

    // SDD section 42. The last attempt of one assertion is its outcome. An earlier repair
    // attempt is history, and it must not decide what the Proof Pack reports.
    const latest = new Map<string, (typeof resultRows)[number]>();
    for (const row of resultRows) {
      const held = latest.get(row.assertionKey);
      if (held === undefined || row.attempt >= held.attempt) latest.set(row.assertionKey, row);
    }

    // SDD section 42. A repair leaves the artefacts of the failed attempt beside those of the
    // passing one. Only the last attempt describes the change Factoree published, so a failure
    // screenshot must never sit next to a PASS. A row that carries no attempt yields -1, and
    // every row of that assertion then matches, so nothing is ever silently dropped.
    const lastAttemptByAssertion = new Map<string, number>();
    for (const row of evidenceRows) {
      if (row.validationAssertionId === null) continue;
      const attempt = metadataNumber(row.metadata, "attempt");
      const held = lastAttemptByAssertion.get(row.validationAssertionId);
      if (held === undefined || attempt > held) {
        lastAttemptByAssertion.set(row.validationAssertionId, attempt);
      }
    }

    const evidenceByAssertion = new Map<string, ProofPackEvidenceRef[]>();
    for (const row of evidenceRows) {
      if (row.validationAssertionId === null) continue;
      if (metadataNumber(row.metadata, "attempt") !== lastAttemptByAssertion.get(row.validationAssertionId)) {
        continue;
      }
      const list = evidenceByAssertion.get(row.validationAssertionId) ?? [];
      list.push({
        kind: row.kind,
        source: row.source,
        sha256: row.sha256,
        storageRef: row.storageRef,
      });
      evidenceByAssertion.set(row.validationAssertionId, list);
    }

    const assertions: ProofPackAssertion[] = contract.assertions.map((assertion) => {
      const outcome = latest.get(assertion.id);
      return {
        id: assertion.id,
        requirement: assertion.requirement,
        statement: assertion.statement,
        method: assertion.method,
        requiredEvidence: assertion.evidence,
        // An assertion with no result row proved nothing. BLOCKED is the honest report, and
        // SDD section 68 then refuses the completion.
        result: outcome?.result ?? "BLOCKED",
        reason: outcome?.reason ?? "No result row exists for this assertion.",
        evidence: evidenceByAssertion.get(assertion.rowId) ?? [],
      };
    });

    // SDD section 42. `verify` writes one evidence row per check PER ATTEMPT, so a Run that
    // repaired holds the failing rows of the earlier attempt as well. Only the last attempt
    // describes the change Factoree published, and a stale failing row would tell the human
    // that a passing Run failed its own verification.
    const checkRows = evidenceRows.filter((row) => row.kind === "deterministic_check");
    const lastCheckAttempt = checkRows.reduce(
      (held, row) => Math.max(held, metadataNumber(row.metadata, "attempt")),
      -1,
    );

    // SDD section 47 forbids a raw log dump, so only the named fields travel. The `log` key of
    // the evidence metadata is never read here, and a spread would defeat the whole rule.
    const checks: ProofPackCheck[] = checkRows
      .filter((row) => metadataNumber(row.metadata, "attempt") === lastCheckAttempt)
      .map((row) => ({
        name: metadataText(row.metadata, "name"),
        command: metadataText(row.metadata, "command"),
        exitCode: metadataNumber(row.metadata, "exitCode"),
        passed: row.metadata["passed"] === true,
        durationMs: metadataNumber(row.metadata, "durationMs"),
        stdoutSha256: metadataText(row.metadata, "stdoutSha256"),
        stderrSha256: metadataText(row.metadata, "stderrSha256"),
      }));

    // SDD section 42. Only the last review pass describes the change Factoree published. An
    // earlier pass reported a defect a repair already closed. The attempt comes from the caller,
    // never from the rows: a passing review writes no row at all, so the highest stored attempt
    // is the earlier FAILING pass, and using it would report a repaired blocker as open.
    const findings = findingRows
      .filter((row) => row.attempt === input.reviewAttempt)
      .map((row) => ({
        id: row.findingKey,
        severity: row.severity,
        category: row.category,
        requirement: row.requirement,
        evidence: row.evidence,
        description: row.description,
        blocking: row.blocking,
        decisionReason: row.decisionReason,
        attempt: row.attempt,
      }));

    // Specification section 18. The Routing section names the Product, the Linear team, every
    // RunTarget and its merge order, and the siblings a target read. Section 14 supplies the
    // per-target facts on the RunTarget rows; this reads them, rather than the workflow's
    // in-flight values, because a persisted record is what the Proof Pack is built from.
    const [product, runTargets, repositories] = await Promise.all([
      dependencies.products.findById(input.tenantId, input.productId),
      dependencies.runs.listRunTargets(input.tenantId, input.runId),
      dependencies.repositories.listByProduct(input.productId),
    ]);
    const fullNameById = new Map(repositories.map((repository) => [repository.id, repository.fullName]));
    const siblingReads = new Map<string, { fullName: string; commitSha: string }>();
    for (const row of evidenceRows) {
      if (row.kind !== "sibling_read") continue;
      const fullName = metadataText(row.metadata, "fullName");
      const commitSha = metadataText(row.metadata, "commitSha");
      if (fullName === "") continue;
      siblingReads.set(fullName, { fullName, commitSha });
    }
    const routing: ProofPackRouting | undefined =
      product === null
        ? undefined
        : {
            productSlug: product.slug,
            linearTeamKey: product.linearTeamKey,
            targets: runTargets.map((target) => ({
              fullName: fullNameById.get(target.repositoryId) ?? target.repositoryId,
              baseSha: target.baseSha ?? "",
              pullRequestUrl: target.pullRequestUrl ?? "",
              mergeOrder: target.mergeOrder,
            })),
            siblingsRead: [...siblingReads.values()],
            selectionReason: runTargets[0]?.selectionReason ?? "sole member",
          };

    const items = contextContract?.items ?? [];
    const body = dependencies.redactor.redactText(
      renderProofPack({
        runId: input.runId,
        workItem: input.workItem,
        pullRequestUrl: input.pullRequestUrl,
        assertions,
        checks,
        reviewVerdict: input.reviewVerdict,
        reviewPasses: input.reviewPasses,
        findings,
        contextItems: items
          .filter((item) => item.classification !== "discoverable")
          .map((item) => ({
            ref: item.reference.ref,
            authority: item.authority,
            classification: item.classification,
            sourceVersion: item.sourceVersion,
            contentSha256: item.contentSha256,
            reason: item.reason,
          })),
        discoverableItemCount: items.filter((item) => item.classification === "discoverable").length,
        conflicts: (contextContract?.conflicts ?? [])
          .filter((conflict) => conflict.resolution === "resolved")
          .map((conflict) => ({
            id: conflict.id,
            subject: conflict.subject,
            winnerRef: conflict.winnerRef,
            loserRef: conflict.loserRef,
            reason: conflict.reason,
          })),
        changedFiles: input.changedFiles,
        patchByteLength: input.patchByteLength,
        previewUrl: input.previewUrl,
        baseSha: input.baseSha,
        patchSha256: input.patchSha256,
        commitSha: input.commitSha,
        repairCount: input.repairCount,
        repairLimit: input.repairLimit,
        autonomyLevel: input.autonomyLevel,
        autonomyReasons: input.autonomyReasons,
        checkDefiningFiles: input.checkDefiningFiles,
        ...(routing === undefined ? {} : { routing }),
      }),
    );

    const sha256 = hashProofPack(body);
    const postedAt = new Date();

    // The durable record comes first. A Linear outage must not lose the proof that the Proof
    // Pack exists, and the activity retry then posts the identical body again.
    await dependencies.runs.setProofPack(input.tenantId, input.runId, { sha256, postedAt });
    await dependencies.agentSession.respond(input.sessionId, body);

    dependencies.logger.info("proof pack posted", {
      tenant_id: input.tenantId,
      run_id: input.runId,
      step: "proof_pack",
      proof_pack_sha256: sha256,
    });

    return {
      sha256,
      assertionCount: assertions.length,
      limitationCount: findings.filter((finding) => !finding.blocking).length,
      postedAt: postedAt.toISOString(),
    };
  },
});
