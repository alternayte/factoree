import type { EvidenceStore } from "~/domain/evidence/evidence.js";
import type { EvidenceStorage } from "~/domain/evidence/evidence-storage.js";
import type { ValidationResultStore } from "~/domain/validation/validation-result-store.js";
import type { AssertionOutcome, EvidenceArtifact } from "~/domain/validation/validation-result.js";
import type { Logger } from "~/telemetry/logger.js";

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
 * extension, so it is not a file name. The assertion key and the artefact kind give a readable
 * name, and the content type gives the extension.
 */
export const storageNameOf = (assertionKey: string, artifact: EvidenceArtifact): string => {
  const base = [safeSegment(assertionKey), safeSegment(artifact.kind)]
    .filter((segment) => segment.length > 0)
    .join("-");
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
        metadata: artifact.metadata,
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
