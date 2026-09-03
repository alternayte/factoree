import type { RepositoryRecord } from "~/domain/products/repository-registry.js";

export type TargetOutcome =
  | { kind: "selected"; repository: RepositoryRecord; reason: string; notify: boolean }
  | { kind: "ambiguous"; candidates: RepositoryRecord[] };

/**
 * Specification section 10. A confident proposal takes priority: it selects a matching
 * repository, or it makes the result ambiguous when no member matches its name. Absent a
 * confident proposal, a sole member needs no decision. Every other case is ambiguous, and the
 * human decides.
 */
export const selectTarget = (
  repositories: RepositoryRecord[],
  proposal: { fullName: string; reason: string; confident: boolean } | null,
): TargetOutcome => {
  const present = repositories.filter((candidate) => candidate.absentSince === null);
  if (proposal !== null && proposal.confident) {
    const chosen = present.find((candidate) => candidate.fullName === proposal.fullName);
    if (chosen === undefined) return { kind: "ambiguous", candidates: present };
    return { kind: "selected", repository: chosen, reason: proposal.reason, notify: true };
  }
  const sole = present[0];
  if (present.length === 1 && sole !== undefined) {
    return { kind: "selected", repository: sole, reason: "sole member", notify: false };
  }
  return { kind: "ambiguous", candidates: present };
};
