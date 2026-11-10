/**
 * docs/specs/claude-code-runner.md. The runner, the model and the effort of each agent role. The
 * Product holds a default runner and a default model, and each role may override both. The
 * repository never chooses a runner: `.factoree/config.yaml` is untrusted input, and the runner
 * decides which paid credential a session spends.
 */

export const AGENT_RUNNERS = ["opencode", "claude"] as const;
export type AgentRunnerName = (typeof AGENT_RUNNERS)[number];

export const PRODUCT_ROLES = ["refiner", "implementer", "validator", "reviewer", "setup"] as const;
export type ProductRole = (typeof PRODUCT_ROLES)[number];

/** One nullable value per role. */
export type RoleValues<T> = Record<ProductRole, T | null>;

/** The Claude Code `--effort` levels. Claude Code lowers a level a model lacks to the next one it has. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The Claude Code model aliases. A full `claude-*` id is also accepted. */
export const CLAUDE_MODEL_ALIASES = ["opus", "sonnet", "haiku", "fable"] as const;

const OPENCODE_MODEL = /^[^\s/]+\/\S+$/;
const CLAUDE_MODEL_ID = /^claude-[a-z0-9.-]+(\[1m\])?$/;

export const isAgentRunnerName = (value: string): value is AgentRunnerName =>
  (AGENT_RUNNERS as readonly string[]).includes(value);

/** The agent settings of a Product, as `ProductRecord` holds them. */
export interface ProductAgentSettings {
  defaultRunner: AgentRunnerName;
  /** The default model, in the form of the default runner, or null for the CLI default. */
  model: string | null;
  runners: RoleValues<AgentRunnerName>;
  models: RoleValues<string>;
  /** A null setup effort takes the implementer's effort. */
  effort: RoleValues<string>;
}

export interface ResolvedRoleSettings {
  runner: AgentRunnerName;
  model: string | null;
  effort: string | null;
}

/**
 * What one role runs. A role that overrides the runner and not the model takes the default model
 * only when the default runner is the same runner: a model of one runner means nothing to the
 * other.
 */
export const resolveRole = (settings: ProductAgentSettings, role: ProductRole): ResolvedRoleSettings => {
  const runner = settings.runners[role] ?? settings.defaultRunner;
  const model = settings.models[role] ?? (runner === settings.defaultRunner ? settings.model : null);
  const effort = settings.effort[role] ?? (role === "setup" ? settings.effort.implementer : null);
  return { runner, model, effort };
};

/** Why a model does not fit a runner, or null when it fits. */
export const modelProblem = (runner: AgentRunnerName, model: string): string | null => {
  if (runner === "opencode") {
    return OPENCODE_MODEL.test(model) ? null : `"${model}" is not an opencode model. Name it as provider/model.`;
  }
  if ((CLAUDE_MODEL_ALIASES as readonly string[]).includes(model) || CLAUDE_MODEL_ID.test(model)) return null;
  return `"${model}" is not a Claude Code model. Use ${CLAUDE_MODEL_ALIASES.join(", ")} or a full claude-* id.`;
};

/** Why an effort does not fit a runner, or null when it fits. opencode takes its variant names from the model catalog. */
export const effortProblem = (runner: AgentRunnerName, effort: string): string | null => {
  if (runner === "opencode") return null;
  return (CLAUDE_EFFORTS as readonly string[]).includes(effort)
    ? null
    : `"${effort}" is not a Claude Code effort. Use ${CLAUDE_EFFORTS.join(", ")}.`;
};

/** Every mismatch of the resolved settings, by field path. An empty result means the settings save. */
export const agentSettingsProblems = (settings: ProductAgentSettings): Record<string, string> => {
  const problems: Record<string, string> = {};
  if (settings.model !== null) {
    const problem = modelProblem(settings.defaultRunner, settings.model);
    if (problem !== null) problems["model"] = problem;
  }
  for (const role of PRODUCT_ROLES) {
    const resolved = resolveRole(settings, role);
    if (settings.models[role] !== null && resolved.model !== null) {
      const problem = modelProblem(resolved.runner, resolved.model);
      if (problem !== null) problems[`models.${role}`] = problem;
    }
    if (resolved.effort !== null) {
      const problem = effortProblem(resolved.runner, resolved.effort);
      // A setup with no effort of its own takes the implementer's, and the message says so.
      if (problem !== null) {
        problems[`effort.${role}`] = settings.effort[role] === null ? `The implementer effort ${problem}` : problem;
      }
    }
  }
  return problems;
};

/** The runner credential names that let Claude Code call a model. */
export const CLAUDE_CREDENTIAL_NAMES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/** True when the runner environment holds a credential Claude Code can call a model with. */
export const hasClaudeCredential = (environment: Record<string, string>): boolean =>
  CLAUDE_CREDENTIAL_NAMES.some((name) => (environment[name] ?? "") !== "");

/**
 * The host a Claude Code session calls: the host of `ANTHROPIC_BASE_URL` when the Product holds
 * one, else the Anthropic API. A base URL that does not parse gives no host, and the session then
 * fails on its first call with the CLI's own message.
 */
export const claudeApiHostOf = (environment: Record<string, string>): string | null => {
  const base = environment["ANTHROPIC_BASE_URL"];
  if (base === undefined || base === "") return "api.anthropic.com";
  try {
    return new URL(base).hostname || null;
  } catch {
    return null;
  }
};
