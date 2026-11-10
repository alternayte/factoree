import type { AgentRunnerName, ProductAgentSettings } from "./agent-settings.js";
import { CLAUDE_MODEL_ALIASES, resolveRole } from "./agent-settings.js";
import { catalogFor, type RawCatalog, type RawModel } from "./model-catalog.js";

/**
 * docs/specs/work-item-images-and-links.md. Before preparation, Factoree reads the input types of
 * each role model from the stored models.dev catalog. A model the catalog does not know counts as
 * no `image` input: Factoree must not guess that an agent saw the image.
 */

/** The four roles of a run that receive the images. */
export const VISION_ROLES = ["refiner", "implementer", "validator", "reviewer"] as const;
export type VisionRole = (typeof VISION_ROLES)[number];

export interface RoleModel {
  role: VisionRole;
  runner: AgentRunnerName;
  /** The resolved model, or null for the CLI default. */
  model: string | null;
}

/** The runner and the model each of the four roles of a run resolves to. */
export const roleModelsOf = (settings: ProductAgentSettings): RoleModel[] =>
  VISION_ROLES.map((role) => {
    const resolved = resolveRole(settings, role);
    return { role, runner: resolved.runner, model: resolved.model };
  });

/** One role whose model cannot read an image. */
export interface VisionGap {
  role: VisionRole;
  runner: AgentRunnerName;
  model: string | null;
  /** A catalog model of the same provider that reads images, in the runner's form, or null. */
  suggestion: string | null;
}

const hasImageInput = (model: RawModel | undefined): boolean => {
  const modalities = model?.["modalities"] as { input?: unknown } | undefined;
  return Array.isArray(modalities?.input) && modalities.input.includes("image");
};

const ANTHROPIC = "anthropic";

/** The usable models of one provider, newest first, as the picker lists them. */
const usableModelIds = (raw: RawCatalog, runner: AgentRunnerName, providerId: string): string[] => {
  const provider = raw[providerId];
  if (provider === undefined) return [];
  return catalogFor({ [providerId]: provider }, runner)[0]?.models.map((model) => model.id) ?? [];
};

/**
 * DI-21.42. True when the catalog shows that the role model reads images. For the claude runner,
 * an alias names the newest usable Anthropic model whose id starts with `claude-<alias>`, a
 * `[1m]` suffix is dropped, and the CLI default reads images only when every usable Anthropic
 * model does. For opencode, the CLI default is unknown, so it reads no image.
 */
export const readsImages = (raw: RawCatalog | null, runner: AgentRunnerName, model: string | null): boolean => {
  if (raw === null) return false;
  if (runner === "claude") {
    const models = raw[ANTHROPIC]?.models ?? {};
    if (model === null) {
      const usable = usableModelIds(raw, runner, ANTHROPIC);
      return usable.length > 0 && usable.every((id) => hasImageInput(models[id]));
    }
    const plain = model.replace(/\[1m\]$/, "");
    if ((CLAUDE_MODEL_ALIASES as readonly string[]).includes(plain)) {
      const newest = usableModelIds(raw, runner, ANTHROPIC).find((id) => id.startsWith(`claude-${plain}`));
      return newest !== undefined && hasImageInput(models[newest]);
    }
    return hasImageInput(models[plain]);
  }
  if (model === null) return false;
  const slash = model.indexOf("/");
  if (slash <= 0) return false;
  return hasImageInput(raw[model.slice(0, slash)]?.models?.[model.slice(slash + 1)]);
};

/** The newest usable model of the role model's provider that reads images, in the runner's form. */
export const visionSuggestion = (raw: RawCatalog | null, runner: AgentRunnerName, model: string | null): string | null => {
  if (raw === null) return null;
  const providerId = runner === "claude" ? ANTHROPIC : model === null ? null : model.slice(0, Math.max(0, model.indexOf("/")));
  if (providerId === null || providerId === "") return null;
  const models = raw[providerId]?.models ?? {};
  const id = usableModelIds(raw, runner, providerId).find((candidate) => hasImageInput(models[candidate]));
  if (id === undefined) return null;
  return runner === "claude" ? id : `${providerId}/${id}`;
};

/** Every role whose model cannot read an image, in role order. */
export const visionGaps = (raw: RawCatalog | null, roles: RoleModel[]): VisionGap[] =>
  roles
    .filter((role) => !readsImages(raw, role.runner, role.model))
    .map((role) => ({ ...role, suggestion: visionSuggestion(raw, role.runner, role.model) }));

/** The provider name of a model, for the post. */
const providerName = (raw: RawCatalog | null, gap: VisionGap): string => {
  const providerId = gap.runner === "claude" ? ANTHROPIC : (gap.model ?? "").slice(0, Math.max(0, (gap.model ?? "").indexOf("/")));
  const name = raw?.[providerId]?.name;
  return typeof name === "string" ? name : providerId;
};

/** The reply that keeps the run going without the image check. */
export const IGNORE_IMAGES_REPLY = "ignore the images";

/** True when a reply asks Factoree to skip the image check. */
export const ignoresImages = (reply: string): boolean =>
  reply.toLowerCase().replace(/[^a-z]+/g, " ").includes(IGNORE_IMAGES_REPLY);

/**
 * The FAILED_CONFIGURATION message. It names each role, its model and a model of the same
 * provider that reads images, and the two replies Factoree accepts.
 */
export const renderVisionFailure = (raw: RawCatalog | null, gaps: VisionGap[], imageCount: number): string =>
  [
    `Factoree stopped before preparation. The issue holds ${imageCount === 1 ? "1 image" : `${imageCount} images`}, ` +
      "and the catalog does not show that these role models read images, so Factoree cannot know that the agent saw them:",
    ...gaps.map((gap) => {
      const model = gap.model ?? `the ${gap.runner} default model`;
      const provider = providerName(raw, gap);
      const suggestion =
        gap.suggestion === null
          ? provider === ""
            ? "Set a model that reads images."
            : `The catalog lists no ${provider} model that reads images.`
          : `A ${provider} model that reads images: ${gap.suggestion}.`;
      return `- ${gap.role}: ${model} (${gap.runner}). ${suggestion}`;
    }),
    "",
    `Change the model of the role on the product page, then reply here. Or reply "${IGNORE_IMAGES_REPLY}": the follow-up run then freezes that decision and skips the image check.`,
  ].join("\n");
