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
  sandboxRetentionHours: string;
  maxConcurrentRuns: string;
  /** docs/specs/sandbox-provider-spillover.md. The providers the runs may use. Empty allows all. */
  sandboxProviderIds: string[];
  /** docs/specs/setup-app-change-issues.md. How many app-change issues a merged setup creates. */
  appChangeIssues: Product["appChangeIssues"];
  effort: Record<Role, string>;
  defaultAutonomy: AutonomyLevel;
  riskCaps: { label: string; level: AutonomyLevel }[];
  allowedDomains: string;
};

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
    sandboxRetentionHours: String(p.sandboxRetentionHours),
    maxConcurrentRuns: String(p.maxConcurrentRuns),
    sandboxProviderIds: p.sandboxProviderIds,
    appChangeIssues: p.appChangeIssues,
    effort: roleValues((role) => p.effort[role] ?? ""),
    defaultAutonomy: asLevel(p.defaultAutonomy),
    riskCaps: Object.entries(p.riskCaps ?? {}).map(([label, level]) => ({ label, level: asLevel(level) })),
    allowedDomains: p.allowedDomains.join("\n"),
  };
}

type Limits = { key: keyof ProductForm; label: string; min: number; max: number };

export const LIMITS: Limits[] = [
  { key: "maxConcurrentRuns", label: "Parallel runs", min: 1, max: 100 },
  { key: "maxRunMinutes", label: "Run time limit (minutes)", min: 1, max: 600 },
  { key: "silenceMinutes", label: "Silence limit (minutes)", min: 1, max: 240 },
  { key: "sandboxRetentionHours", label: "Sandbox retention (hours)", min: 0, max: 720 },
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
  const [maxConcurrentRuns, maxRunMinutes, silenceMinutes, sandboxRetentionHours] = LIMITS.map(int) as [
    number,
    number,
    number,
    number,
  ];
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
  if (!form.name.trim()) problems.push("The product needs a name.");
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
      sandboxRetentionHours,
      maxConcurrentRuns,
      sandboxProviderIds: form.sandboxProviderIds,
      appChangeIssues: form.appChangeIssues,
      effort: roleValues(effort),
      defaultAutonomy: form.defaultAutonomy,
      riskCaps,
      allowedDomains: form.allowedDomains
        .split(/[\s,]+/)
        .map((d) => d.trim())
        .filter(Boolean),
    },
  };
}
