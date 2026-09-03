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
