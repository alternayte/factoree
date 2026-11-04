import { createHash } from "node:crypto";
import type { RepositorySpec } from "./checkout.js";

/**
 * docs/specs/skill-registry.md. A skill registry holds reviewed, versioned skills and resolves a
 * set to pinned versions. Skael is the first kind. The organization skills repository of SDD
 * section 16 is the second source behind the same port.
 */

/** The Product secret that holds the service key of the registry. It never reaches a sandbox. */
export const SKILL_REGISTRY_KEY_SECRET = "SKILL_REGISTRY_KEY";

export const SKILL_REGISTRY_KINDS = ["skael"] as const;
export type SkillRegistryKind = (typeof SKILL_REGISTRY_KINDS)[number];

/** The registry of one Product. A null set means every released skill. */
export interface SkillRegistrySettings {
  kind: SkillRegistryKind;
  url: string;
  set: string | null;
}

/** One pinned skill version, with the archive whose SHA-256 the worker checked. */
export interface ResolvedSkill {
  name: string;
  version: number;
  sha256: string;
  archive: Uint8Array;
}

/** docs/specs/skill-registry.md. The skill resolution of one run. */
export interface SkillResolution {
  /** The set name, or null for every released skill. */
  set: string | null;
  id: string;
  /** False when the registry excluded an entry of the set, for example a held version. */
  complete: boolean;
  skills: ResolvedSkill[];
}

/**
 * How a source reaches the work sprite. A registry hands the worker checked archives. The
 * organization skills repository is a git checkout inside the sandbox.
 */
export type SkillDelivery =
  | { kind: "archives"; resolution: SkillResolution }
  | { kind: "checkout"; repository: RepositorySpec };

export interface SkillActivationReport {
  runId: string;
  /** Run, attempt and session. A retry with the same key counts nothing twice. */
  idempotencyKey: string;
  runner: string;
  role: "implementer";
  set: string | null;
  resolutionId: string | null;
  time: Date;
  skills: Array<{ name: string; version: number }>;
}

export type SkillRunOutcome = "succeeded" | "failed" | "cancelled";

export interface SkillOutcomeReport {
  runId: string;
  outcome: SkillRunOutcome;
  repairs: number;
  reviewVerdict: string | null;
  evidenceUrl: string | null;
  set: string | null;
  resolutionId: string | null;
}

/** One file of a skill proposal. The text is redacted before it leaves the worker. */
export interface SkillProposalFile {
  path: string;
  content: string;
}

/** docs/specs/skill-registry.md. A skill proposal the implementer wrote in the work sprite. */
export interface SkillProposal {
  name: string;
  rationale: string;
  runId: string;
  /** Where a reviewer finds the run, or null. */
  runLink: string | null;
  files: SkillProposalFile[];
}

export type SkillProposalReceipt =
  | { state: "submitted"; reference: string; url: string | null }
  | { state: "refused"; reason: string };

export type SkillSourceScope = "registry" | "organization";

/** docs/specs/skill-registry.md. One skill source of a Product. */
export interface SkillRegistry {
  readonly scope: SkillSourceScope;
  /** Resolves the skills of one run. */
  resolve(): Promise<SkillDelivery>;
  reportActivations(report: SkillActivationReport): Promise<void>;
  reportOutcome(report: SkillOutcomeReport): Promise<void>;
  submit(proposal: SkillProposal): Promise<SkillProposalReceipt>;
}

/** docs/specs/skill-registry.md. The page of one registry skill for a human. */
export const registrySkillUrl = (settings: SkillRegistrySettings, name: string): string =>
  `${settings.url.replace(/\/+$/, "")}/skills/${encodeURIComponent(name)}`;

/** A registry that the worker cannot reach, or that answers with a fault. */
export class SkillRegistryError extends Error {
  constructor(
    message: string,
    /** True when a retry fails the same way, for example a 403 or a digest mismatch. */
    readonly deterministic: boolean,
  ) {
    super(message);
    this.name = "SkillRegistryError";
  }
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The resolution id of Skael: the SHA-256 of the sorted `name NUL version NUL digest LF` lines. A
 * resolution Factoree builds itself (skael-dev/skael#30) carries the same id Skael would give it.
 */
export const resolutionIdOf = (entries: ReadonlyArray<{ name: string; version: number; sha256: string }>): string => {
  const lines = entries.map((entry) => `${entry.name}\u0000${entry.version}\u0000${entry.sha256}\n`).sort();
  return createHash("sha256").update(lines.join(""), "utf8").digest("hex");
};

/** The directory of a skill proposal, relative to the primary checkout. */
export const SKILL_PROPOSALS_DIRECTORY = ".factoree/skill-proposals";

/** The file that states why the implementer proposes the skill. */
export const SKILL_PROPOSAL_RATIONALE_FILE = "RATIONALE.md";

/** The largest proposal Factoree reads: files, and bytes per file. */
export const MAX_PROPOSAL_FILES = 20;
export const MAX_PROPOSAL_FILE_BYTES = 65_536;
