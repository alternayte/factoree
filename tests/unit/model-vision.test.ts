import { describe, expect, it } from "vitest";
import type { RawCatalog } from "~/domain/products/model-catalog.js";
import { ignoresImages, readsImages, renderVisionFailure, visionGaps } from "~/domain/products/model-vision.js";

const model = (id: string, input: string[], release: string) => ({
  id,
  name: id,
  tool_call: true,
  release_date: release,
  modalities: { input, output: ["text"] },
});

const CATALOG: RawCatalog = {
  deepseek: {
    name: "DeepSeek",
    models: {
      "deepseek-v4-pro": model("deepseek-v4-pro", ["text"], "2026-09-01"),
      "deepseek-v4-vl": model("deepseek-v4-vl", ["text", "image"], "2026-08-01"),
    },
  },
  anthropic: {
    name: "Anthropic",
    models: {
      "claude-opus-4-7": model("claude-opus-4-7", ["text", "image"], "2026-06-01"),
      "claude-sonnet-4-6": model("claude-sonnet-4-6", ["text", "image"], "2026-05-01"),
    },
  },
};

describe("vision check", () => {
  it("finds the implementer model that reads no image and names a model of its provider that does", () => {
    const gaps = visionGaps(CATALOG, [
      { role: "refiner", runner: "claude", model: null },
      { role: "implementer", runner: "opencode", model: "deepseek/deepseek-v4-pro" },
      { role: "validator", runner: "claude", model: "opus" },
      { role: "reviewer", runner: "claude", model: "claude-sonnet-4-6[1m]" },
    ]);
    expect(gaps).toEqual([{ role: "implementer", runner: "opencode", model: "deepseek/deepseek-v4-pro", suggestion: "deepseek/deepseek-v4-vl" }]);
    const post = renderVisionFailure(CATALOG, gaps, 1);
    expect(post).toContain("implementer: deepseek/deepseek-v4-pro (opencode). A DeepSeek model that reads images: deepseek/deepseek-v4-vl.");
    expect(post).toContain('reply "ignore the images"');
  });

  it("counts a model the catalog does not know, and the opencode default, as no image input", () => {
    expect(readsImages(CATALOG, "opencode", "deepseek/deepseek-v9")).toBe(false);
    expect(readsImages(CATALOG, "opencode", null)).toBe(false);
    expect(readsImages(CATALOG, "claude", "claude-unknown-1")).toBe(false);
    expect(readsImages(null, "claude", "opus")).toBe(false);
  });

  it("takes the reply that ignores the images, in any case and punctuation", () => {
    expect(ignoresImages("Ignore the images.")).toBe(true);
    expect(ignoresImages("please IGNORE the   images!")).toBe(true);
    expect(ignoresImages("Do not ignore anything; the images matter")).toBe(false);
  });
});
