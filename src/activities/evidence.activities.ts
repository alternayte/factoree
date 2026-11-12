import type { FactoreeDecision } from "~/domain/runs/factoree-decision.js";
import { NOT_CHECKED_REASON } from "~/domain/runs/run-draft.js";
import { ApplicationFailure } from "@temporalio/activity";
import { canonicalEvidenceHash, type EvidenceStore } from "~/domain/evidence/evidence.js";
import { forYourEyeSource, type ForYourEyeCapture, type ForYourEyeCriterion } from "~/domain/validation/for-your-eye.js";
import type { EvidenceStorage } from "~/domain/evidence/evidence-storage.js";
import type { ValidationResultStore } from "~/domain/validation/validation-result-store.js";
import type { AssertionOutcome, EvidenceArtifact } from "~/domain/validation/validation-result.js";
import type { Logger } from "~/telemetry/logger.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { ContextContractStore } from "~/domain/context/context-contract-store.js";
import type { ValidationContractStore } from "~/domain/validation/validation-contract-store.js";
import type { ReviewFindingStore } from "~/domain/review/review-finding-store.js";
import type { AgentSessionPort } from "~/domain/runs/ports.js";
import { isPlanCorrectionSession, summarizeAgentSessions, type AgentSessionStore } from "~/domain/runs/agent-session.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { registerProjectSecrets } from "~/domain/products/redaction-loader.js";
import type { RunSkillStore } from "~/domain/runs/run-skill.js";
import { registrySkillUrl } from "~/domain/runs/skill-registry.js";
import {
  buildProofPackDocument,
  defaultModelWarning,
  hashProofPack,
  PROOF_PACK_DOCUMENT_NAME,
  renderProofPack,
  type ProofPackAssertion,
  type ProofPackBaseMove,
  type ProofPackCheck,
  type ProofPackEvidenceRef,
  type ProofPackForYourEye,
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

/** docs/specs/by-eye-criteria-and-selector-recheck.md. One for-your-eye capture of one attempt. */
export interface PersistForYourEyeInput {
  tenantId: string;
  runId: string;
  capture: ForYourEyeCapture;
  attempt: number;
}

export interface EvidencePersistence {
  persistAssertionOutcome(input: PersistAssertionOutcomeInput): Promise<void>;
  persistForYourEye(input: PersistForYourEyeInput): Promise<void>;
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

  /**
   * docs/specs/by-eye-criteria-and-selector-recheck.md. Stores the screenshot of one for-your-eye
   * criterion as visual evidence that answers no assertion, or one row with the reason when the
   * capture failed. The Proof Pack reads the row of the last attempt.
   */
  async persistForYourEye(input: PersistForYourEyeInput): Promise<void> {
    const { capture } = input;
    const idempotencyKey = `run:${input.runId}:validation:${input.attempt}:for-your-eye:${capture.id}`;
    const base = { forYourEye: capture.id, statement: capture.statement, route: capture.route, attempt: input.attempt };
    if (capture.captured) {
      const stored = await dependencies.storage.put({
        tenantId: input.tenantId,
        runId: input.runId,
        name: storageNameOf(capture.id, capture.artifact),
        contentType: capture.artifact.contentType,
        bytes: capture.artifact.bytes,
      });
      await dependencies.evidence.record({
        tenantId: input.tenantId,
        runId: input.runId,
        validationAssertionId: null,
        kind: "screenshot",
        source: capture.artifact.source,
        sha256: stored.sha256,
        storageRef: stored.storageRef,
        metadata: { ...capture.artifact.metadata, ...base, captured: true },
        idempotencyKey,
      });
    } else {
      const metadata = { ...base, captured: false, reason: capture.reason };
      await dependencies.evidence.record({
        tenantId: input.tenantId,
        runId: input.runId,
        validationAssertionId: null,
        kind: "screenshot",
        source: forYourEyeSource(capture.id),
        sha256: canonicalEvidenceHash(metadata),
        storageRef: null,
        metadata,
        idempotencyKey,
      });
    }
  },
});

/** Reads the for-your-eye criterion id of an evidence row, or null for any other row. */
const forYourEyeIdOf = (metadata: Record<string, unknown>): string | null =>
  typeof metadata["forYourEye"] === "string" ? metadata["forYourEye"] : null;

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
  /** docs/specs/agent-session-usage-and-hangs.md. The usage rows of the Run's agent sessions. */
  sessions: AgentSessionStore;
  /** docs/specs/proof-pack-and-visual-evidence.md. Stores `proof-pack.json` beside the evidence. */
  storage: EvidenceStorage;
  secrets: SecretStore;
  redactor: Redactor;
  logger: Logger;
  /** docs/specs/skill-registry.md. The skills and the skill proposals of each run. */
  skills?: RunSkillStore | undefined;
  /** docs/specs/sandbox-provider-spillover.md. The name of a sandbox provider, or null when it is gone. */
  sandboxProviderName?: ((providerId: string) => Promise<string | null>) | undefined;
}

export interface PublishProofPackActivityInput {
  runId: string;
  tenantId: string;
  productId: string;
  sessionId: string;
  workItem: { title: string; url: string | null };
  pullRequestUrl: string;
  /**
   * docs/specs/egress-honesty-and-issue-status.md, DI-21.52. True when the session already holds
   * the pull request link from the moment the pull request opened.
   */
  pullRequestLinked?: boolean;
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
  /** docs/specs/proof-pack-and-visual-evidence.md. The Reviewer's description of the change. */
  changeDescription?: string;
  /** docs/specs/proof-pack-and-visual-evidence.md. The visual evidence gap Factoree accepted. */
  visualEvidenceGap?: string | null;
  /**
   * docs/specs/by-eye-criteria-and-selector-recheck.md. The criteria a person judges by eye.
   * Absent in a history recorded before they existed.
   */
  forYourEye?: ForYourEyeCriterion[];
  /** docs/specs/repository-setup-and-services.md. The fakes the last validation ran against. */
  fakes?: Array<{ service: string; name: string }>;
  /** docs/specs/own-proposals-and-parallel-runs.md. Every proposal Factoree took without asking. */
  decisions?: FactoreeDecision[];
  /** docs/specs/own-proposals-and-parallel-runs.md. How far the base branch moved, or null. */
  baseMove?: ProofPackBaseMove | null;
  /** DI-21.56. The wait for a run slot or a sandbox slot. Absent in an older history. */
  waitedMs?: number;
  /** docs/specs/autonomy-levels.md. The level of the Run, and the caps that applied. */
  autonomyLevel: string;
  autonomyReasons: string[];
  /** docs/specs/check-isolation.md. Changed files that define a check. */
  checkDefiningFiles: string[];
  /**
   * docs/specs/draft-of-failed-run.md. The draft of a failed run: the attempt whose check sprite
   * received the published patch, and whether a review of it finished. Only the results, the
   * evidence and the checks of that attempt describe the patch, and every other assertion is not
   * proven.
   */
  draft?: { attempt: number; reviewed: boolean };
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
/** docs/specs/sandbox-provider-spillover.md. The provider name, or its id when the provider is gone. */
const sandboxProviderOf = async (
  dependencies: Pick<ProofPackActivityDependencies, "runs" | "sandboxProviderName">,
  tenantId: string,
  runId: string,
): Promise<string | null> => {
  // A worker without the provider list names no provider.
  if (dependencies.sandboxProviderName === undefined) return null;
  const providerId = (await dependencies.runs.findById(tenantId, runId))?.sandboxProviderId ?? null;
  if (providerId === null) return null;
  return (await dependencies.sandboxProviderName(providerId)) ?? providerId;
};

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
    const sessionRows = await dependencies.sessions.listForRun(input.tenantId, input.runId);

    // SDD section 42. The last attempt of one assertion is its outcome. An earlier repair
    // attempt is history, and it must not decide what the Proof Pack reports.
    const draft = input.draft;
    const latest = new Map<string, (typeof resultRows)[number]>();
    for (const row of resultRows) {
      if (draft !== undefined && row.attempt !== draft.attempt) continue;
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
      if (draft !== undefined && attempt !== draft.attempt) continue;
      const held = lastAttemptByAssertion.get(row.validationAssertionId);
      if (held === undefined || attempt > held) {
        lastAttemptByAssertion.set(row.validationAssertionId, attempt);
      }
    }

    const evidenceByAssertion = new Map<string, ProofPackEvidenceRef[]>();
    // docs/specs/browser-network-control.md. The assertion log of the last attempt records whether
    // the plan injected a failed request.
    const injectedFailure = new Set<string>();
    for (const row of evidenceRows) {
      if (row.validationAssertionId === null) continue;
      if (metadataNumber(row.metadata, "attempt") !== lastAttemptByAssertion.get(row.validationAssertionId)) {
        continue;
      }
      if (row.kind === "assertion-log" && row.metadata["injectedFailure"] === true) {
        injectedFailure.add(row.validationAssertionId);
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

    // docs/specs/by-eye-criteria-and-selector-recheck.md. The screenshot of the last validation
    // attempt, outside every assertion total. Every pass writes a result row, so the highest
    // result attempt is the last pass.
    const lastValidationAttempt = draft?.attempt ?? resultRows.reduce((held, row) => Math.max(held, row.attempt), -1);
    const needsYourEye: ProofPackForYourEye[] = (input.forYourEye ?? []).map((item) => {
      const row = evidenceRows.find(
        (candidate) =>
          candidate.validationAssertionId === null &&
          forYourEyeIdOf(candidate.metadata) === item.id &&
          metadataNumber(candidate.metadata, "attempt") === lastValidationAttempt,
      );
      if (row === undefined) {
        return { ...item, screenshot: null, reason: "Factoree captured no screenshot in the last attempt." };
      }
      if (row.metadata["captured"] !== true) {
        return { ...item, screenshot: null, reason: metadataText(row.metadata, "reason") || "the capture failed." };
      }
      return {
        ...item,
        screenshot: { kind: row.kind, source: row.source, sha256: row.sha256, storageRef: row.storageRef },
        reason: null,
      };
    });

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
        reason: outcome?.reason ?? (draft === undefined ? "No result row exists for this assertion." : NOT_CHECKED_REASON),
        evidence: evidenceByAssertion.get(assertion.rowId) ?? [],
        injectedFailure: injectedFailure.has(assertion.rowId),
      };
    });

    // SDD section 42. `verify` writes one evidence row per check PER ATTEMPT, so a Run that
    // repaired holds the failing rows of the earlier attempt as well. Only the last attempt
    // describes the change Factoree published, and a stale failing row would tell the human
    // that a passing Run failed its own verification.
    const checkRows = evidenceRows.filter((row) => row.kind === "deterministic_check");
    const lastCheckAttempt =
      draft?.attempt ?? checkRows.reduce((held, row) => Math.max(held, metadataNumber(row.metadata, "attempt")), -1);

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
            })),
            siblingsRead: [...siblingReads.values()],
            selectionReason: runTargets[0]?.selectionReason ?? "sole member",
          };

    const skillRows = (await dependencies.skills?.list(input.tenantId, input.runId)) ?? [];
    const proposalRows = (await dependencies.skills?.listProposals(input.tenantId, input.runId)) ?? [];

    // Issue 6, DI-15.17. Read from the stored Product and sessions, so no workflow input changes.
    const modelWarning =
      product === null
        ? null
        : defaultModelWarning({
            productModel: product.model,
            hasRunnerCredential: (await dependencies.secrets.list(input.tenantId, input.productId)).some(
              (secret) => secret.kind === "runner_credential",
            ),
            sessions: sessionRows,
          });

    const items = contextContract?.items ?? [];
    const proofPackInput = {
      runId: input.runId,
      workItem: input.workItem,
      pullRequestUrl: input.pullRequestUrl,
      changeDescription: input.changeDescription ?? "",
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
      checkPreviewUrl: input.previewUrl,
      baseSha: input.baseSha,
      patchSha256: input.patchSha256,
      commitSha: input.commitSha,
      repairCount: input.repairCount,
      repairLimit: input.repairLimit,
      autonomyLevel: input.autonomyLevel,
      autonomyReasons: input.autonomyReasons,
      checkDefiningFiles: input.checkDefiningFiles,
      visualEvidenceGap: input.visualEvidenceGap ?? null,
      needsYourEye,
      fakes: input.fakes ?? [],
      decisions: input.decisions ?? [],
      baseMove: input.baseMove ?? null,
      // docs/specs/agent-session-usage-and-hangs.md. Cost is a metric beside the proof, never part of it.
      agentUsage: summarizeAgentSessions(sessionRows),
      waitedMs: input.waitedMs ?? 0,
      sandboxProvider: await sandboxProviderOf(dependencies, input.tenantId, input.runId),
      modelWarning,
      // DI-15.23. A plan correction session marks a pass whose first Validation Plan was rejected.
      planCorrections: sessionRows
        .filter(isPlanCorrectionSession)
        .map((row) => ({ attempt: row.attempt, outcome: row.outcome }))
        .sort((left, right) => left.attempt - right.attempt),
      ...(routing === undefined ? {} : { routing }),
      // docs/specs/skill-registry.md. The skills the implementer loaded, and its proposals.
      skills: skillRows
        .filter((skill) => skill.activated)
        .map((skill) => ({
          name: skill.name,
          source: skill.scope,
          version: skill.version,
          url:
            skill.scope === "registry" && product?.skillRegistry != null
              ? registrySkillUrl(product.skillRegistry, skill.name)
              : null,
        })),
      skillProposals: proposalRows.map((proposal) => ({
        name: proposal.name,
        source: proposal.source,
        state: proposal.state,
        url: proposal.url,
        reason: proposal.reason,
      })),
      ...(draft === undefined ? {} : { draft: { reviewed: draft.reviewed } }),
    };

    // docs/specs/proof-pack-and-visual-evidence.md. An agent reads the full record as typed data.
    // The text passes the redactor before it leaves the worker, exactly as the body does.
    const documentText = dependencies.redactor.redactText(
      JSON.stringify(buildProofPackDocument(proofPackInput), null, 2),
    );
    const document = JSON.parse(documentText) as Record<string, unknown>;
    const stored = await dependencies.storage.put({
      tenantId: input.tenantId,
      runId: input.runId,
      name: PROOF_PACK_DOCUMENT_NAME,
      contentType: "application/json",
      bytes: Buffer.from(documentText, "utf8"),
    });

    const body = dependencies.redactor.redactText(renderProofPack(proofPackInput, stored.storageRef));

    const sha256 = hashProofPack(body);
    const postedAt = new Date();

    // The durable record comes first. A Linear outage must not lose the proof that the Proof
    // Pack exists, and the activity retry then posts the identical body again.
    await dependencies.runs.setProofPack(input.tenantId, input.runId, { sha256, postedAt, document });
    // Linear documents the session link as the way to name a published pull request.
    if (input.pullRequestLinked !== true) {
      await dependencies.agentSession.addLink(input.sessionId, "Pull request", input.pullRequestUrl);
    }
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
