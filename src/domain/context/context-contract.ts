import { createHash } from "node:crypto";
import { AUTHORITY_CLASSES } from "./authority.js";
import type { ContextConflictRecord, SelectedContextItem } from "./conflicts.js";
import { CONTEXT_CLASSIFICATIONS } from "./context-source.js";

/** SDD section 21 fixes the document schema version. */
export const CONTEXT_CONTRACT_VERSION = 1 as const;

/**
 * SDD section 18 disables organization-wide unbounded retrieval by default. AT-09 keeps a large
 * repository available through a tool, and out of the initial prompt. These two values are that
 * default. The resolver demotes an item past the budget to `discoverable`. It never drops the
 * item, so the contract still explains it. See controller decision 12.
 */
export const CONTEXT_REQUIRED_MAX_ITEMS = 20;
export const CONTEXT_REQUIRED_MAX_BYTES = 64 * 1024;

export interface ContextContractRepository {
  repo: string;
  sha: string;
}

export interface ContextContractReferenceRepository extends ContextContractRepository {
  reason: string;
}

/** SDD section 21. The immutable record of the context one Run uses. */
export interface ContextContract {
  version: typeof CONTEXT_CONTRACT_VERSION;
  runId: string;
  goal: string;
  primaryRepository: ContextContractRepository;
  referenceRepositories: ContextContractReferenceRepository[];
  items: SelectedContextItem[];
  conflicts: ContextConflictRecord[];
}

export class ContextContractInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextContractInvalidError";
  }
}

const SHA = /^[0-9a-f]{40}$/;

const KNOWN_AUTHORITIES = new Set<string>(AUTHORITY_CLASSES);
const KNOWN_CLASSIFICATIONS = new Set<string>(CONTEXT_CLASSIFICATIONS);

const present = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.trim() !== "";

/**
 * AT-06. Every selected Context Item must carry a source, a version, an authority class, and a
 * reason. Absent provenance fails Context Contract validation. SDD section 21 adds the stable
 * reference and the classification. SDD section 55 adds the content hash where it is practical,
 * so a preloaded item must carry one.
 */
export const validateContextContract = (contract: ContextContract): void => {
  const fail = (message: string): never => {
    throw new ContextContractInvalidError(message);
  };

  if (!SHA.test(contract.primaryRepository.sha)) {
    fail(
      `The primary repository ${contract.primaryRepository.repo} has no explicit commit SHA: ` +
        `"${contract.primaryRepository.sha}".`,
    );
  }
  for (const repository of contract.referenceRepositories) {
    if (!SHA.test(repository.sha)) {
      fail(
        `The reference repository ${repository.repo} has no explicit commit SHA: ` +
          `"${repository.sha}".`,
      );
    }
  }

  const seen = new Set<string>();
  for (const item of contract.items) {
    const name = item.reference.ref === "" ? "an item with no reference" : item.reference.ref;
    if (!present(item.reference.sourceId)) fail(`Context item "${name}" records no source.`);
    if (!present(item.reference.ref)) fail(`A context item records no stable reference.`);
    if (!present(item.sourceVersion)) fail(`Context item "${name}" records no source version.`);
    if (!KNOWN_AUTHORITIES.has(item.authority)) {
      fail(`Context item "${name}" records the unknown authority class "${item.authority}".`);
    }
    if (!present(item.reason)) fail(`Context item "${name}" records no selection reason.`);
    if (!KNOWN_CLASSIFICATIONS.has(item.classification)) {
      fail(`Context item "${name}" records the unknown classification "${item.classification}".`);
    }
    // A required item enters the initial role context. Factoree made a promise to reproduce that
    // exact content. SDD section 55.
    if (item.classification === "required" && !present(item.contentSha256)) {
      fail(`Context item "${name}" is required and records no content hash.`);
    }
    if (seen.has(item.reference.ref)) fail(`Context item "${name}" appears twice.`);
    seen.add(item.reference.ref);
  }
};

/** A JSON text whose object keys are sorted, so one contract always hashes the same. */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
  return `{${entries.join(",")}}`;
};

/** SDD section 21 requires an immutable contract. The hash is its identity. */
export const hashContextContract = (contract: ContextContract): string =>
  createHash("sha256").update(canonical(contract)).digest("hex");

const itemLine = (item: SelectedContextItem): string => {
  const where = item.reference.path === null ? item.reference.ref : item.reference.path;
  const repository = item.reference.repository === null ? "" : `${item.reference.repository} `;
  return (
    `- ${repository}${where} — authority ${item.authority}, ${item.classification}, ` +
    `version ${item.sourceVersion}, hash ${item.contentSha256 ?? "not recorded"}. ` +
    `Selected because ${item.reason}.`
  );
};

/**
 * The human-readable Context Contract. The Phase 4 exit condition is that Factoree can explain
 * what context it uses before code changes start. This text is that explanation. It holds no file
 * body, because SDD section 55 forbids a copy of a repository. AT-09 forbids a preload of a large
 * repository.
 */
export const renderContextContract = (contract: ContextContract): string => {
  const references =
    contract.referenceRepositories.length === 0
      ? ["- None."]
      : contract.referenceRepositories.map(
          (repository) => `- ${repository.repo} at ${repository.sha} — ${repository.reason}`,
        );

  const items = contract.items.length === 0 ? ["- None."] : contract.items.map(itemLine);

  const conflicts =
    contract.conflicts.length === 0
      ? ["- None."]
      : contract.conflicts.map((conflict) =>
          conflict.resolution === "resolved"
            ? `- ${conflict.id} on "${conflict.subject}": ${conflict.winnerRef ?? ""} wins over ` +
              `${conflict.loserRef ?? ""}. ${conflict.reason}`
            : `- ${conflict.id} on "${conflict.subject}": unresolved. ${conflict.reason}`,
        );

  return [
    "# Context Contract",
    "",
    `version: ${contract.version}`,
    `runId: ${contract.runId}`,
    "",
    "## Goal",
    "",
    contract.goal,
    "",
    "## Primary repository",
    "",
    `- ${contract.primaryRepository.repo} at ${contract.primaryRepository.sha}`,
    "",
    "## Reference repositories",
    "",
    ...references,
    "",
    "## Selected context",
    "",
    ...items,
    "",
    "## Context conflicts",
    "",
    ...conflicts,
    "",
  ].join("\n");
};

/** SDD section 21. Only a required item enters the initial role context. */
export const requiredContextLines = (contract: ContextContract): string[] =>
  contract.items.filter((item) => item.classification === "required").map(itemLine);
