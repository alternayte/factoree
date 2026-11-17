import type { RepositoryRecord } from "~/domain/products/repository-registry.js";

export type TargetOutcome =
  | { kind: "selected"; repository: RepositoryRecord; reason: string; notify: boolean }
  | { kind: "ambiguous"; candidates: RepositoryRecord[] };

/**
 * Specification section 10. A sole member needs no decision. A confident proposal proceeds and
 * posts a notice. Every other case is ambiguous, and the human decides.
 */
export const selectTarget = (
  repositories: RepositoryRecord[],
  proposal: { fullName: string; reason: string; confident: boolean } | null,
): TargetOutcome => {
  const present = repositories.filter((candidate) => candidate.absentSince === null);
  const sole = present[0];
  if (present.length === 1 && sole !== undefined) {
    return { kind: "selected", repository: sole, reason: "sole member", notify: false };
  }
  if (proposal === null || !proposal.confident) return { kind: "ambiguous", candidates: present };
  const chosen = present.find((candidate) => candidate.fullName === proposal.fullName);
  if (chosen === undefined) return { kind: "ambiguous", candidates: present };
  return { kind: "selected", repository: chosen, reason: proposal.reason, notify: true };
};

/** A repository name the issue text names, matched as a whole name in any case. */
const mentions = (text: string, name: string): boolean => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  // A name ends at a character that cannot continue it. A sentence period still ends it.
  return new RegExp(`(^|[^A-Za-z0-9_.\\-/])${escaped}(?![A-Za-z0-9_\\-/]|\\.[A-Za-z0-9])`, "i").test(text);
};

/**
 * docs/specs/own-proposals-and-parallel-runs.md. The two deterministic target rules. Rule one: the
 * issue text names exactly one repository, by its full name or by a short name no other
 * repository shares. Rule two: the issue's Linear project matches exactly one repository's
 * declared projects. Null when neither rule decides, and the human then chooses.
 */
export const proposeTarget = (
  repositories: RepositoryRecord[],
  issueText: string,
  linearProject: string | null,
): { fullName: string; reason: string; confident: true } | null => {
  const present = repositories.filter((candidate) => candidate.absentSince === null);
  const shortName = (fullName: string): string => fullName.split("/").at(-1) ?? fullName;
  const named = present.flatMap((candidate) => {
    const short = shortName(candidate.fullName);
    const shared = present.some(
      (other) => other !== candidate && shortName(other.fullName).toLowerCase() === short.toLowerCase(),
    );
    if (mentions(issueText, candidate.fullName)) return [{ candidate, name: candidate.fullName }];
    if (!shared && mentions(issueText, short)) return [{ candidate, name: short }];
    return [];
  });
  const onlyNamed = named[0];
  if (named.length === 1 && onlyNamed !== undefined) {
    return { fullName: onlyNamed.candidate.fullName, reason: `the issue names ${onlyNamed.name}`, confident: true };
  }

  const project = linearProject?.trim().toLowerCase() ?? "";
  if (project === "") return null;
  const declaring = present.filter((candidate) =>
    candidate.linearProjects.some((declared) => declared.trim().toLowerCase() === project),
  );
  const onlyDeclaring = declaring[0];
  if (declaring.length === 1 && onlyDeclaring !== undefined) {
    return {
      fullName: onlyDeclaring.fullName,
      reason: `the issue is in the Linear project "${linearProject?.trim() ?? ""}", which ${onlyDeclaring.fullName} declares`,
      confident: true,
    };
  }
  return null;
};

/** docs/specs/change-sets.md. The starting set of a run, or the candidates a human chooses from. */
export type TargetSetOutcome =
  | { kind: "selected"; repositories: RepositoryRecord[]; reason: string; notify: boolean }
  | { kind: "ambiguous"; candidates: RepositoryRecord[] };

/** The repositories of a set in one fixed order: the full name, without case. DI-21.130. */
export const inSetOrder = <T extends { fullName: string }>(repositories: readonly T[]): T[] =>
  [...repositories].sort((left, right) => {
    const a = left.fullName.toLowerCase();
    const b = right.fullName.toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  });

/** Joins names as a person writes a list: "a", "a and b", "a, b and c". */
const sentenceList = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;

/**
 * docs/specs/change-sets.md, DI-21.130. The worker rules of the own-proposals spec, extended from
 * one repository to many. Rule one: every repository the issue text names, by its full name or by
 * a short name no other repository shares. Rule two, only when the issue names none: every
 * repository that declares the issue's Linear project. Null when neither rule decides, and the
 * human then chooses. The set is in set order.
 */
export const proposeTargets = (
  repositories: RepositoryRecord[],
  issueText: string,
  linearProject: string | null,
): { fullNames: string[]; reason: string } | null => {
  const present = repositories.filter((candidate) => candidate.absentSince === null);
  const shortName = (fullName: string): string => fullName.split("/").at(-1) ?? fullName;
  const named = inSetOrder(present).flatMap((candidate) => {
    const short = shortName(candidate.fullName);
    const shared = present.some(
      (other) => other !== candidate && shortName(other.fullName).toLowerCase() === short.toLowerCase(),
    );
    if (mentions(issueText, candidate.fullName)) return [{ candidate, name: candidate.fullName }];
    if (!shared && mentions(issueText, short)) return [{ candidate, name: short }];
    return [];
  });
  if (named.length > 0) {
    return {
      fullNames: named.map((entry) => entry.candidate.fullName),
      reason: `the issue names ${sentenceList(named.map((entry) => entry.name))}`,
    };
  }

  const project = linearProject?.trim().toLowerCase() ?? "";
  if (project === "") return null;
  const declaring = inSetOrder(present).filter((candidate) =>
    candidate.linearProjects.some((declared) => declared.trim().toLowerCase() === project),
  );
  if (declaring.length === 0) return null;
  const names = declaring.map((candidate) => candidate.fullName);
  return {
    fullNames: names,
    reason: `the issue is in the Linear project "${linearProject?.trim() ?? ""}", which ${sentenceList(names)} ${names.length === 1 ? "declares" : "declare"}`,
  };
};

/**
 * docs/specs/change-sets.md. A sole member needs no decision. A proposal of the worker rules
 * proceeds and posts a notice. Every other case is ambiguous, and the human decides.
 */
export const selectTargets = (
  repositories: RepositoryRecord[],
  proposal: { fullNames: string[]; reason: string } | null,
): TargetSetOutcome => {
  const present = repositories.filter((candidate) => candidate.absentSince === null);
  const sole = present[0];
  if (present.length === 1 && sole !== undefined) {
    return { kind: "selected", repositories: [sole], reason: "sole member", notify: false };
  }
  if (proposal === null) return { kind: "ambiguous", candidates: present };
  const chosen = proposal.fullNames.map((fullName) => present.find((candidate) => candidate.fullName === fullName));
  if (chosen.length === 0 || chosen.some((candidate) => candidate === undefined)) return { kind: "ambiguous", candidates: present };
  return { kind: "selected", repositories: inSetOrder(chosen.filter((candidate) => candidate !== undefined)), reason: proposal.reason, notify: true };
};

/**
 * docs/specs/change-sets.md. The candidates a human reply names, in set order. A reply token is a
 * full name, or a short name that one candidate alone carries; case does not count. Empty when the
 * reply names none.
 */
export const matchReplyToCandidates = <T extends { fullName: string }>(reply: string, candidates: T[]): T[] => {
  // A slash and a hyphen survive the trim, so `org/repo-name` stays one token.
  const tokens = reply
    .split(/\s+/)
    .map((token) => token.replace(/^[^\w/]+|[^\w/-]+$/g, "").toLowerCase())
    .filter((token) => token.length > 0);
  const bareOf = (fullName: string): string => (fullName.split("/").at(-1) ?? fullName).toLowerCase();
  const bareNameOwners = new Map<string, number>();
  for (const candidate of candidates) bareNameOwners.set(bareOf(candidate.fullName), (bareNameOwners.get(bareOf(candidate.fullName)) ?? 0) + 1);
  return inSetOrder(
    candidates.filter((candidate) => {
      if (tokens.includes(candidate.fullName.toLowerCase())) return true;
      const bare = bareOf(candidate.fullName);
      return tokens.includes(bare) && bareNameOwners.get(bare) === 1;
    }),
  );
};
