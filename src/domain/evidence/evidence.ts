import { createHash } from "node:crypto";
import type { ValidationEvidenceKind } from "~/domain/validation/validation-contract.js";

/**
 * SDD section 39. Evidence is immutable. Each artifact records an identifier, the Run, the
 * Validation assertion it answers, its kind, its source, the moment it was created, its hash,
 * a storage reference, and metadata.
 *
 * A deterministic verification check answers no Validation assertion, so
 * `validationAssertionId` is null for it. SDD section 37 and section 38 name the artefact kinds a
 * user validation assertion produces, and this type adds them.
 *
 * `sibling_read` answers no Validation assertion either. It records that the agent session
 * cloned a sibling repository of the Run's Product, so the Reviewer can see which sibling the
 * Implementer read.
 */
export type EvidenceKind = "deterministic_check" | "sibling_read" | ValidationEvidenceKind;

export interface EvidenceRecord {
  id: string;
  tenantId: string;
  runId: string;
  validationAssertionId: string | null;
  kind: EvidenceKind;
  /** What produced the artifact, for example `verify:typecheck`. */
  source: string;
  createdAt: Date;
  sha256: string;
  storageRef: string | null;
  metadata: Record<string, unknown>;
}

export interface RecordEvidenceInput {
  tenantId: string;
  runId: string;
  validationAssertionId?: string | null;
  kind: EvidenceKind;
  source: string;
  sha256: string;
  storageRef?: string | null;
  metadata: Record<string, unknown>;
  /** A Temporal retry of one activity must not write a second row. */
  idempotencyKey: string;
}

export interface EvidenceStore {
  /**
   * Writes one evidence row. A second call with the same idempotency key returns the row that
   * already exists and changes nothing, because SDD section 39 makes evidence immutable.
   */
  record(input: RecordEvidenceInput): Promise<EvidenceRecord>;
  listForRun(tenantId: string, runId: string): Promise<EvidenceRecord[]>;
}

/** Sorts the keys of every object, so one value always produces one text. */
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
};

/**
 * The hash of one evidence record. SDD section 39 requires a `sha256` for the artifact, and
 * SDD section 35 requires a separate stdout hash and stderr hash. The row holds all three: this
 * value covers the whole record, and the two output hashes live in its metadata.
 */
export const canonicalEvidenceHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
