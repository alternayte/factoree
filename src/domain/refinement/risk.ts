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

const UNCONFIGURED_REPOSITORY = "unconfigured-repository:";

/** The plain sentence for one risk token. A human reads this text in Linear. */
export const describeRisk = (risk: string): string => {
  if (risk === "no-acceptance-criteria") {
    return (
      "The Work Item states no acceptance criterion. Factoree proposed one for each sentence " +
      "of the goal. Correct a proposal that is wrong."
    );
  }
  if (risk.startsWith(UNCONFIGURED_REPOSITORY)) {
    const slug = risk.slice(UNCONFIGURED_REPOSITORY.length);
    return (
      `The Work Item names the repository "${slug}". The Project record does not list it, so ` +
      "Factoree ignores it. Add it to the Project to make Factoree read it."
    );
  }
  if ((HIGH_RISK_LABELS as readonly string[]).includes(risk)) {
    return (
      `The Work Item carries the high-risk label "${risk}". Factoree caps the autonomy level ` +
      "of this Run at L2, so a human must approve the result."
    );
  }
  return risk;
};

/** The progress message for the risks of one refinement. An empty list produces no message. */
export const renderRisks = (risks: readonly string[]): string | null => {
  if (risks.length === 0) return null;
  const lines = risks.map((risk) => `- ${describeRisk(risk)}`).join("\n");
  return `Refinement found these risks in this Work Item:\n${lines}`;
};
