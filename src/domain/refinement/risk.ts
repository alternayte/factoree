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
 * docs/specs/autonomy-levels.md. The SDD section 28 caps a Product starts with: each default
 * high-risk label allows L2 at most. An operator changes them through the administration API.
 */
export const DEFAULT_RISK_CAPS: Readonly<Record<string, AutonomyLevel>> = Object.fromEntries(
  HIGH_RISK_LABELS.map((label) => [label, "L2"]),
);

/** A Linear label that lowers the level of one Work Item. No label raises it. */
const LOWERING_LABELS: Readonly<Record<string, AutonomyLevel>> = {
  "factoree:l0": "L0",
  "factoree:l1": "L1",
  "factoree:l2": "L2",
};

/** Version 1 never merges, so L3 is the highest level a Run can reach. SDD section 27. */
const HIGHEST = "L3";

export interface AutonomyInput {
  /** The Product default level. A pending Product is L0. */
  defaultLevel: string;
  labels: string[];
  /** The caps of the Product, by label. Null means `DEFAULT_RISK_CAPS`. */
  riskCaps: Readonly<Record<string, string>> | null;
  /** True when the labels of the Work Item could not be read. The cap then fails closed. */
  labelsUnreadable: boolean;
}

export interface AutonomyDecision {
  level: AutonomyLevel;
  /** One sentence for each rule that lowered the level. The Proof Pack shows them. */
  reasons: string[];
}

/**
 * docs/specs/autonomy-levels.md. The level of one Run. Every rule can only lower the level, so
 * the result is never above the Product default and never above L3.
 */
export const decideAutonomy = (input: AutonomyInput): AutonomyDecision => {
  const reasons: string[] = [];
  const known = rankOf(input.defaultLevel);
  // An unrecognised level falls back to L2, because a lower level is always the safe direction.
  let rank = known < 0 ? rankOf("L2") : Math.min(known, rankOf(HIGHEST));
  const lower = (to: string, reason: string) => {
    const target = rankOf(to);
    if (target >= 0 && target < rank) {
      rank = target;
      reasons.push(reason);
    }
  };

  if (input.labelsUnreadable) {
    lower("L2", "Factoree could not read the labels of this Work Item, so it runs this Run at L2.");
  }
  const caps = input.riskCaps ?? DEFAULT_RISK_CAPS;
  const labels = [...new Set(input.labels.map((label) => label.trim().toLowerCase()))];
  for (const label of labels) {
    const cap = caps[label];
    if (cap !== undefined) lower(cap, `The label "${label}" caps this Run at ${cap}.`);
  }
  for (const label of labels) {
    const lowered = LOWERING_LABELS[label];
    if (lowered !== undefined) lower(lowered, `The label "${label}" lowers this Run to ${lowered}.`);
  }
  return { level: AUTONOMY_LEVELS[rank] ?? "L2", reasons };
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
    return `The Work Item carries the high-risk label "${risk}".`;
  }
  return risk;
};

/** The progress message for the risks of one refinement. An empty list produces no message. */
export const renderRisks = (risks: readonly string[]): string | null => {
  if (risks.length === 0) return null;
  const lines = risks.map((risk) => `- ${describeRisk(risk)}`).join("\n");
  return `Refinement found these risks in this Work Item:\n${lines}`;
};
