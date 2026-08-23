/** SDD section 28. The default high-risk labels, in the order the specification lists them. */
export const HIGH_RISK_LABELS = [
  "security",
  "authentication",
  "authorization",
  "payments",
  "billing",
  "cryptography",
  "database-migration",
  "infrastructure",
  "secrets",
] as const;

export const AUTONOMY_LEVELS = ["L0", "L1", "L2", "L3", "L4"] as const;

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** The SDD section 28 labels a Work Item carries, in the SDD order and without a duplicate. */
export const highRiskLabelsOf = (labels: string[]): string[] => {
  const present = new Set(labels.map((label) => label.trim().toLowerCase()));
  return HIGH_RISK_LABELS.filter((label) => present.has(label));
};

const rankOf = (level: string): number => AUTONOMY_LEVELS.indexOf(level as AutonomyLevel);

/**
 * SDD section 28. A high-risk label caps autonomy at L2 unless Project policy overrides the cap,
 * and no Project policy override exists in Version 1. SDD section 27 reserves L4 for a future
 * version, so L4 can never survive. An unrecognised level falls back to L2, because a lower
 * level is always the safe direction.
 */
export const capAutonomy = (level: string, highRisk: boolean): AutonomyLevel => {
  const rank = rankOf(level);
  if (rank < 0) return "L2";
  const ceiling = highRisk ? rankOf("L2") : rankOf("L3");
  return AUTONOMY_LEVELS[Math.min(rank, ceiling)] ?? "L2";
};
