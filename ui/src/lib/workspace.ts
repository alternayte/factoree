import type { Membership } from "@/lib/session";

/** pickWorkspace returns the membership the search names, or the first membership. */
export function pickWorkspace(memberships: Membership[], linearWorkspaceId: string | undefined): Membership | undefined {
  return memberships.find((m) => m.linearWorkspaceId === linearWorkspaceId) ?? memberships[0];
}

export const AUTONOMY_LEVELS = ["L0", "L1", "L2", "L3"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const EFFORT_ROLES = ["implementer", "refiner", "validator", "reviewer"] as const;
export const EFFORT_SUGGESTIONS = ["low", "high", "max"];
