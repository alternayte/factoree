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
