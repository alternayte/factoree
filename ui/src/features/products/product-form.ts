import type { GetProductResponse, UpdateProductData } from "@/api/types.gen";
import { AUTONOMY_LEVELS, EFFORT_ROLES, type AutonomyLevel } from "@/lib/workspace";

export type Product = GetProductResponse;
type Role = (typeof EFFORT_ROLES)[number];
export type Runner = Product["defaultRunner"];

export type ProductForm = {
  name: string;
  /** docs/specs/claude-code-runner.md. The runner and the model of every role that names none. */
  defaultRunner: Runner;
  model: string;
  /** An empty runner or model takes the default. */
  runners: Record<Role, Runner | "">;
  models: Record<Role, string>;
  organizationSkillsRepository: string;
  /** docs/specs/skill-registry.md. An empty URL means no registry. An empty set means every released skill. */
  skillRegistryUrl: string;
  skillRegistrySet: string;
  /** A new service key. Empty keeps the stored one. */
  skillRegistryKey: string;
  maxRunMinutes: string;
  silenceMinutes: string;
  /** Issue #39. The most criteria a refiner proposal may hold. */
  refinerCriteriaLimit: string;
  /** Issue #43. The repair budget of a run whose repository sets none. */
  repairMaxAttempts: string;
  sandboxRetentionHours: string;
  maxConcurrentRuns: string;
  /** docs/specs/sandbox-provider-spillover.md. The providers the runs may use. Empty allows all. */
  sandboxProviderIds: string[];
  /** docs/specs/setup-app-change-issues.md. How many app-change issues a merged setup creates. */
  appChangeIssues: Product["appChangeIssues"];
  /** docs/specs/pr-feedback-loop.md. The review app slugs Factoree does not act on, one per line. */
  reviewAppDenyList: string;
  /** docs/specs/pr-feedback-loop.md. The most PR follow-up runs that review apps and CI start on one pull request. */
  automaticFollowUpLimit: string;
  effort: Record<Role, string>;
  defaultAutonomy: AutonomyLevel;
  riskCaps: { label: string; level: AutonomyLevel }[];
  allowedDomains: string;
  /** docs/specs/retro-agent.md. The product goal in markdown. Empty clears it. */
  productGoal: string;
  keepTranscripts: boolean;
  /** docs/specs/retro-web-research.md. The retro agent may search the web through the retro gateway. */
  webResearch: boolean;
  retroRetentionDays: string;
  /** docs/specs/s3-object-store.md. The days the object store keeps video and traces. Empty keeps them. */
  evidenceRetentionDays: string;
};

/** docs/specs/retro-agent.md. The limits of the product goal and of the retro data retention. */
export const PRODUCT_GOAL_MAX_BYTES = 16 * 1024;
export const RETRO_RETENTION = { min: 7, max: 365 } as const;
/** docs/specs/s3-object-store.md. The limits of the evidence retention. */
export const EVIDENCE_RETENTION = { min: 1, max: 3650 } as const;

export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

const asLevel = (value: string): AutonomyLevel =>
  (AUTONOMY_LEVELS as readonly string[]).includes(value) ? (value as AutonomyLevel) : "L2";

function roleValues<T>(of: (role: Role) => T): Record<Role, T> {
  return Object.fromEntries(EFFORT_ROLES.map((role) => [role, of(role)])) as Record<Role, T>;
}

/**
 * docs/specs/claude-code-runner.md, the same rule as src/domain/products/agent-settings.ts. A role
 * that overrides the runner and not the model takes the default model only on the default runner.
 */
export function resolvedRole(form: ProductForm, role: Role): { runner: Runner; model: string; effort: string } {
  const runner = form.runners[role] || form.defaultRunner;
  const model = form.models[role].trim() || (runner === form.defaultRunner ? form.model.trim() : "");
  const effort = form.effort[role].trim() || (role === "setup" ? form.effort.implementer.trim() : "");
  return { runner, model, effort };
}

export function formOf(p: Product): ProductForm {
  return {
    name: p.name,
    defaultRunner: p.defaultRunner,
    model: p.model ?? "",
    runners: roleValues((role) => p.runners[role] ?? ""),
    models: roleValues((role) => p.models[role] ?? ""),
    organizationSkillsRepository: p.organizationSkillsRepository ?? "",
    skillRegistryUrl: p.skillRegistry?.url ?? "",
    skillRegistrySet: p.skillRegistry?.set ?? "",
    skillRegistryKey: "",
    maxRunMinutes: String(p.maxRunMinutes),
    silenceMinutes: String(p.silenceMinutes),
    refinerCriteriaLimit: String(p.refinerCriteriaLimit),
    repairMaxAttempts: String(p.repairMaxAttempts),
    sandboxRetentionHours: String(p.sandboxRetentionHours),
    maxConcurrentRuns: String(p.maxConcurrentRuns),
    sandboxProviderIds: p.sandboxProviderIds,
    appChangeIssues: p.appChangeIssues,
    reviewAppDenyList: p.reviewAppDenyList.join("\n"),
    automaticFollowUpLimit: String(p.automaticFollowUpLimit),
    effort: roleValues((role) => p.effort[role] ?? ""),
    defaultAutonomy: asLevel(p.defaultAutonomy),
    riskCaps: Object.entries(p.riskCaps ?? {}).map(([label, level]) => ({ label, level: asLevel(level) })),
    allowedDomains: p.allowedDomains.join("\n"),
    productGoal: p.productGoal ?? "",
    keepTranscripts: p.keepTranscripts,
    webResearch: p.webResearch,
    retroRetentionDays: String(p.retroRetentionDays),
    evidenceRetentionDays: p.evidenceRetentionDays === null ? "" : String(p.evidenceRetentionDays),
  };
}

type Limits = { key: keyof ProductForm; label: string; min: number; max: number };

export const LIMITS: Limits[] = [
  { key: "maxConcurrentRuns", label: "Parallel runs", min: 1, max: 100 },
  { key: "maxRunMinutes", label: "Run time limit (minutes)", min: 1, max: 600 },
  { key: "silenceMinutes", label: "Silence limit (minutes)", min: 1, max: 240 },
  { key: "sandboxRetentionHours", label: "Sandbox retention (hours)", min: 0, max: 720 },
  { key: "refinerCriteriaLimit", label: "Refiner criteria limit", min: 1, max: 50 },
  { key: "repairMaxAttempts", label: "Repair budget (attempts)", min: 0, max: 10 },
  { key: "automaticFollowUpLimit", label: "Automatic follow-ups per PR", min: 1, max: 20 },
];

/** bodyOf builds the full update body, or the problems that stop a save. */
export function bodyOf(form: ProductForm): { body: UpdateProductData["body"] } | { problems: string[] } {
  const problems: string[] = [];
  const int = (limit: Limits): number => {
    const raw = String(form[limit.key]).trim();
    const n = Number(raw);
    if (!raw || !Number.isInteger(n) || n < limit.min || n > limit.max) {
      problems.push(`${limit.label} must be a whole number from ${limit.min} to ${limit.max}.`);
    }
    return n;
  };
  const [
    maxConcurrentRuns,
    maxRunMinutes,
    silenceMinutes,
    sandboxRetentionHours,
    refinerCriteriaLimit,
    repairMaxAttempts,
    automaticFollowUpLimit,
  ] = LIMITS.map(int) as [number, number, number, number, number, number, number];
  const riskCaps: Record<string, AutonomyLevel> = {};
  for (const cap of form.riskCaps) {
    const label = cap.label.trim().toLowerCase();
    if (!label) {
      problems.push("Every risk cap needs a label.");
      continue;
    }
    if (label in riskCaps) problems.push(`The label “${label}” has two risk caps.`);
    riskCaps[label] = cap.level;
  }
  // The API checks each model and effort against the runner its role resolves to.
  const model = form.model.trim();
  const skills = form.organizationSkillsRepository.trim();
  if (skills && !/^[^/]+\/[^/]+$/.test(skills))
    problems.push("The skills repository must have the form owner/repository.");
  const registryUrl = form.skillRegistryUrl.trim();
  if (registryUrl && !/^https?:\/\/\S+$/.test(registryUrl))
    problems.push("The skill registry URL must start with http:// or https://.");
  if (!registryUrl && form.skillRegistrySet.trim()) problems.push("A skill set needs a skill registry URL.");
  const reviewAppDenyList = form.reviewAppDenyList
    .split(/[\s,]+/)
    .map((slug) => slug.trim().replace(/\[bot\]$/i, ""))
    .filter(Boolean);
  for (const slug of reviewAppDenyList) {
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(slug))
      problems.push(`The review app “${slug}” is no GitHub App slug: use letters, digits and hyphens.`);
  }
  if (!form.name.trim()) problems.push("The product needs a name.");
  if (byteLength(form.productGoal) > PRODUCT_GOAL_MAX_BYTES)
    problems.push(`The product goal must be at most ${PRODUCT_GOAL_MAX_BYTES / 1024} KiB.`);
  const retention = Number(form.retroRetentionDays.trim());
  if (!form.retroRetentionDays.trim() || !Number.isInteger(retention) || retention < RETRO_RETENTION.min || retention > RETRO_RETENTION.max)
    problems.push(`Retro data retention must be a whole number of days from ${RETRO_RETENTION.min} to ${RETRO_RETENTION.max}.`);
  const evidenceRaw = form.evidenceRetentionDays.trim();
  const evidenceRetention = evidenceRaw ? Number(evidenceRaw) : null;
  if (
    evidenceRetention !== null &&
    (!Number.isInteger(evidenceRetention) ||
      evidenceRetention < EVIDENCE_RETENTION.min ||
      evidenceRetention > EVIDENCE_RETENTION.max)
  )
    problems.push(
      `Evidence retention must be empty or a whole number of days from ${EVIDENCE_RETENTION.min} to ${EVIDENCE_RETENTION.max}.`,
    );
  if (problems.length > 0) return { problems };
  const effort = (role: Role) => form.effort[role].trim() || null;
  return {
    body: {
      name: form.name.trim(),
      defaultRunner: form.defaultRunner,
      model: model || null,
      runners: roleValues((role) => form.runners[role] || null),
      models: roleValues((role) => form.models[role].trim() || null),
      organizationSkillsRepository: skills || null,
      skillRegistry: registryUrl
        ? { kind: "skael", url: registryUrl, set: form.skillRegistrySet.trim() || null }
        : null,
      maxRunMinutes,
      silenceMinutes,
      refinerCriteriaLimit,
      repairMaxAttempts,
      sandboxRetentionHours,
      maxConcurrentRuns,
      sandboxProviderIds: form.sandboxProviderIds,
      appChangeIssues: form.appChangeIssues,
      reviewAppDenyList,
      automaticFollowUpLimit,
      effort: roleValues(effort),
      defaultAutonomy: form.defaultAutonomy,
      riskCaps,
      allowedDomains: form.allowedDomains
        .split(/[\s,]+/)
        .map((d) => d.trim())
        .filter(Boolean),
      // An empty goal clears it.
      productGoal: form.productGoal.trim() ? form.productGoal : "",
      keepTranscripts: form.keepTranscripts,
      webResearch: form.webResearch,
      retroRetentionDays: retention,
      evidenceRetentionDays: evidenceRetention,
    },
  };
}
