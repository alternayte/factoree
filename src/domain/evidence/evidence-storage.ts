import { createHash } from "node:crypto";

export interface StoredArtifact {
  /** What the active adapter returned. It is opaque to the domain. */
  storageRef: string;
  /** The SHA-256 of the exact bytes that were stored. */
  sha256: string;
  byteLength: number;
}

export interface PutArtifactInput {
  tenantId: string;
  runId: string;
  /** A stable, readable file name, for example `VAL-UI-001-after-reload.png`. */
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * SDD section 39. Version 1 SHOULD store user-facing evidence through Linear private file
 * storage where practical. The port keeps that choice out of the domain, and it keeps every
 * test free of a live Linear account. See DI-7.8.
 */
export interface EvidenceStorage {
  readonly name: string;
  put(input: PutArtifactInput): Promise<StoredArtifact>;
}

export const hashArtifactBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
