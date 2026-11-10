import type { AgentRunnerName } from "./agent-settings.js";
import { CLAUDE_EFFORTS } from "./agent-settings.js";

/**
 * docs/specs/model-picker.md. The models.dev catalog, the one opencode itself reads. The raw
 * document is an object keyed by provider id. Factoree keeps it raw, because the sandbox model
 * file of an opencode session must hold the raw provider entry.
 */
export type RawCatalog = Record<string, RawProvider>;

export interface RawProvider {
  id?: string;
  name?: string;
  env?: string[];
  npm?: string;
  models?: Record<string, RawModel>;
  [key: string]: unknown;
}

export interface RawModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{ type?: string; values?: Array<string | null> }>;
  tool_call?: boolean;
  release_date?: string;
  status?: string;
  type?: string;
  limit?: { context?: number };
  cost?: { input?: number; output?: number };
  [key: string]: unknown;
}

/** One model, as the picker shows it. */
export interface CatalogModel {
  /** The model id inside its provider. The runner model is `provider/id` for opencode and `id` for claude. */
  id: string;
  name: string;
  reasoning: boolean;
  /** The effort values the runner accepts for this model, in catalog order. Empty hides the control. */
  efforts: string[];
  contextTokens: number | null;
  /** US dollars per million input and output tokens, or null when the catalog names none. */
  costInput: number | null;
  costOutput: number | null;
  releaseDate: string | null;
}

export interface CatalogProvider {
  id: string;
  name: string;
  /** The environment variables the provider reads its key from. The first one is the one to set. */
  env: string[];
  models: CatalogModel[];
}

/** The npm packages for which opencode turns a reasoning toggle into the variants none and high. */
const TOGGLE_VARIANT_PACKAGES = new Set(["@ai-sdk/alibaba", "@ai-sdk/cohere"]);

/**
 * The `--variant` names opencode 1.19.5 derives for a model (`reasoningVariants()` in
 * packages/opencode/src/provider/transform.ts): the effort values in catalog order; else none and
 * high for a toggle on the packages above; else high and max for a token budget; else none.
 */
export const opencodeVariantsOf = (model: RawModel, npm: string | undefined): string[] => {
  const options = model.reasoning_options ?? [];
  if (options.length === 0) return [];
  const effort = options.find((option) => option.type === "effort");
  // opencode names a null effort value "none".
  if (effort !== undefined) return (effort.values ?? []).map((value) => value ?? "none");
  if (npm !== undefined && TOGGLE_VARIANT_PACKAGES.has(npm) && options.some((option) => option.type === "toggle")) {
    return ["none", "high"];
  }
  if (options.some((option) => option.type === "budget_tokens")) return ["high", "max"];
  return [];
};

/** The Claude Code effort levels a model accepts: its catalog effort values that Claude Code knows. */
export const claudeEffortsOf = (model: RawModel): string[] => {
  const values = model.reasoning_options?.find((option) => option.type === "effort")?.values ?? [];
  return CLAUDE_EFFORTS.filter((effort) => values.includes(effort));
};

/** A model an agent can use: not deprecated, a text model, and able to call tools. */
const usable = (model: RawModel): boolean =>
  model.status !== "deprecated" && model.tool_call === true && (model.type === undefined || model.type === "text");

const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * The catalog of one runner. The claude runner calls Anthropic models only. Providers sort by
 * name, and the models of a provider by release date, newest first.
 */
export const catalogFor = (raw: RawCatalog, runner: AgentRunnerName): CatalogProvider[] => {
  const providers: CatalogProvider[] = [];
  for (const [providerId, provider] of Object.entries(raw)) {
    if (runner === "claude" && providerId !== "anthropic") continue;
    const models: CatalogModel[] = [];
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      if (!usable(model)) continue;
      models.push({
        id: modelId,
        name: typeof model.name === "string" ? model.name : modelId,
        reasoning: model.reasoning === true,
        efforts: runner === "claude" ? claudeEffortsOf(model) : opencodeVariantsOf(model, provider.npm),
        contextTokens: numberOrNull(model.limit?.context),
        costInput: numberOrNull(model.cost?.input),
        costOutput: numberOrNull(model.cost?.output),
        releaseDate: typeof model.release_date === "string" ? model.release_date : null,
      });
    }
    if (models.length === 0) continue;
    models.sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || a.name.localeCompare(b.name));
    providers.push({
      id: providerId,
      name: typeof provider.name === "string" ? provider.name : providerId,
      env: Array.isArray(provider.env) ? provider.env.filter((name): name is string => typeof name === "string") : [],
      models,
    });
  }
  return providers.sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * The listed model a runner model names, or null when the catalog does not list it. An opencode
 * model is `provider/model`. A claude model is an Anthropic model id.
 */
export const findCatalogModel = (
  raw: RawCatalog,
  runner: AgentRunnerName,
  model: string,
): { provider: CatalogProvider; model: CatalogModel } | null => {
  const providerId = runner === "claude" ? "anthropic" : model.slice(0, model.indexOf("/"));
  const modelId = runner === "claude" ? model : model.slice(model.indexOf("/") + 1);
  if (providerId === "" || raw[providerId] === undefined) return null;
  const provider = catalogFor({ [providerId]: raw[providerId] }, runner)[0];
  const found = provider?.models.find((entry) => entry.id === modelId);
  return provider === undefined || found === undefined ? null : { provider, model: found };
};

/** Why an effort does not fit a listed model, or null when it fits or the model is not listed. */
export const catalogEffortProblem = (raw: RawCatalog, runner: AgentRunnerName, model: string, effort: string): string | null => {
  const found = findCatalogModel(raw, runner, model);
  if (found === null || found.model.efforts.includes(effort)) return null;
  return found.model.efforts.length === 0
    ? `${found.model.name} takes no effort. Leave the effort empty.`
    : `${found.model.name} takes the effort ${found.model.efforts.join(", ")}, not "${effort}".`;
};

/** The fields of a sibling model that a typed model of the same provider most likely shares. */
const SIBLING_FIELDS = ["attachment", "temperature", "reasoning", "reasoning_options", "interleaved", "limit", "modalities", "provider"] as const;

/** opencode 1.19.5 reads `limit.context` and `limit.output` of every model. Used only for a provider with no model to copy. */
const FALLBACK_LIMIT = { context: 200_000, output: 32_000 };

/**
 * The catalog entry of an opencode model the catalog does not list yet, such as a model released
 * after the last refresh. opencode 1.19.5 refuses a model id its catalog lacks
 * (`ProviderModelNotFoundError`), so the entry copies the shape of the newest usable model of the
 * same provider under the typed id. It names no cost: a guessed price is worse than none. An effort
 * the copied shape does not offer becomes the one effort variant, so `--variant` resolves.
 */
const typedModelEntry = (provider: RawProvider, modelId: string, effort: string | null): RawModel => {
  const siblings = Object.values(provider.models ?? {})
    .filter(usable)
    .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""));
  const sibling = siblings[0];
  const entry: RawModel = { id: modelId, name: modelId, release_date: "", tool_call: true, attachment: false, reasoning: false, temperature: true, limit: FALLBACK_LIMIT };
  if (sibling !== undefined) {
    const fields: Record<string, unknown> = entry;
    for (const field of SIBLING_FIELDS) if (sibling[field] !== undefined) fields[field] = sibling[field];
  }
  if (effort !== null && !opencodeVariantsOf(entry, provider.npm).includes(effort)) {
    entry.reasoning = true;
    entry.reasoning_options = [{ type: "effort", values: [effort] }];
  }
  return entry;
};

/**
 * The content of the sandbox model file of an opencode session: the raw entry of the provider
 * of the model, keyed by its id, as `OPENCODE_MODELS_PATH` expects. A model the provider entry
 * lacks gets a typed model entry. Null when the catalog does not list the provider: opencode then
 * keeps its own snapshot.
 */
export const opencodeModelsFileOf = (raw: RawCatalog, model: string, effort: string | null = null): string | null => {
  const providerId = model.slice(0, model.indexOf("/"));
  const modelId = model.slice(model.indexOf("/") + 1);
  const provider = providerId === "" ? undefined : raw[providerId];
  if (provider === undefined) return null;
  if (provider.models?.[modelId] !== undefined) return JSON.stringify({ [providerId]: provider });
  const typed = { ...provider, id: provider.id ?? providerId, models: { ...provider.models, [modelId]: typedModelEntry(provider, modelId, effort) } };
  return JSON.stringify({ [providerId]: typed });
};
