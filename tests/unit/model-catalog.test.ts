import { describe, expect, it } from "vitest";
import { catalogEffortProblem, catalogFor, opencodeModelsFileOf, opencodeProviderConfigOf, type RawCatalog } from "~/domain/products/model-catalog.js";
import { ModelCatalogService, type StoredCatalog } from "~/domain/products/model-catalog-service.js";

// docs/specs/model-picker.md. Shapes from models.dev api.json, read 2026-11-09.
const RAW: RawCatalog = {
  anthropic: {
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-sonnet-5-5": {
        name: "Claude Sonnet 5.5",
        reasoning: true,
        tool_call: true,
        release_date: "2026-09-28",
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        limit: { context: 1_000_000 },
        cost: { input: 2, output: 10 },
      },
      "claude-haiku-4-5": { name: "Claude Haiku 4.5", reasoning: true, tool_call: true, reasoning_options: [{ type: "budget_tokens" }] },
      "claude-old": { name: "Old", tool_call: true, status: "deprecated" },
    },
  },
  deepseek: {
    name: "DeepSeek",
    env: ["DEEPSEEK_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    models: {
      "deepseek-flash": {
        name: "DeepSeek Flash",
        reasoning: true,
        tool_call: true,
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
      },
      "deepseek-embed": { name: "Embed", tool_call: false, type: "embedding" },
    },
  },
};

describe("catalogFor", () => {
  it("derives the opencode variants as opencode 1.19.5 does, and hides deprecated and tool-less models", () => {
    const providers = catalogFor(RAW, "opencode");
    expect(providers.map((provider) => provider.id)).toEqual(["anthropic", "deepseek"]);
    const anthropic = providers[0]!;
    expect(anthropic.env).toEqual(["ANTHROPIC_API_KEY"]);
    expect(anthropic.models.map((model) => [model.id, model.efforts])).toEqual([
      ["claude-sonnet-5-5", ["low", "medium", "high", "xhigh", "max"]],
      // A token budget gives high and max.
      ["claude-haiku-4-5", ["high", "max"]],
    ]);
    // An effort entry wins over a toggle, in catalog order.
    expect(providers[1]!.models.map((model) => [model.id, model.efforts])).toEqual([["deepseek-flash", ["low", "high", "max"]]]);
  });

  it("lists Anthropic alone for the claude runner, with the Claude Code efforts the model accepts", () => {
    const providers = catalogFor(RAW, "claude");
    expect(providers.map((provider) => provider.id)).toEqual(["anthropic"]);
    expect(providers[0]!.models.map((model) => [model.id, model.efforts])).toEqual([
      ["claude-sonnet-5-5", ["low", "medium", "high", "xhigh", "max"]],
      ["claude-haiku-4-5", []],
    ]);
  });
});

describe("catalogEffortProblem", () => {
  it("names the allowed values of a listed model, and leaves an unlisted model to the runner rule", () => {
    expect(catalogEffortProblem(RAW, "opencode", "deepseek/deepseek-flash", "medium")).toBe(
      'DeepSeek Flash takes the effort low, high, max, not "medium".',
    );
    expect(catalogEffortProblem(RAW, "opencode", "deepseek/deepseek-flash", "max")).toBeNull();
    expect(catalogEffortProblem(RAW, "claude", "claude-haiku-4-5", "high")).toBe("Claude Haiku 4.5 takes no effort. Leave the effort empty.");
    expect(catalogEffortProblem(RAW, "opencode", "deepseek/deepseek-v9", "medium")).toBeNull();
  });
});

describe("opencodeModelsFileOf", () => {
  it("holds the raw provider entry of the model, keyed by its id", () => {
    expect(JSON.parse(opencodeModelsFileOf(RAW, "deepseek/deepseek-flash") ?? "null")).toEqual({ deepseek: RAW["deepseek"] });
    expect(opencodeModelsFileOf(RAW, "nobody/model")).toBeNull();
  });

  it("adds a typed model the catalog lacks, in the shape of the newest sibling, with its effort as a variant", () => {
    const fileOf = (effort: string | null) => JSON.parse(opencodeModelsFileOf(RAW, "anthropic/claude-sonnet-6", effort) ?? "null") as RawCatalog;
    const file = fileOf(null);
    const typed = file["anthropic"]!.models!["claude-sonnet-6"]!;
    // opencode 1.19.5 refuses a model id its catalog lacks, and reads limit of every model.
    expect(typed).toMatchObject({ id: "claude-sonnet-6", tool_call: true, limit: { context: 1_000_000 } });
    expect(typed.reasoning_options).toEqual(RAW["anthropic"]!.models!["claude-sonnet-5-5"]!.reasoning_options);
    expect(typed.cost).toBeUndefined();
    expect(file["anthropic"]!.models!["claude-sonnet-5-5"]).toEqual(RAW["anthropic"]!.models!["claude-sonnet-5-5"]);
    const odd = fileOf("turbo")["anthropic"]!.models!["claude-sonnet-6"]!;
    expect(odd.reasoning_options).toEqual([{ type: "effort", values: ["turbo"] }]);
  });
});

// GitHub issue 37. Shapes from models.dev api.json, read 2026-11-12.
const AZURE: RawCatalog = {
  azure: {
    env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"],
    npm: "@ai-sdk/azure",
    models: {
      "gpt-5.5": { tool_call: true, release_date: "2026-08-01" },
      "claude-opus-5-5": {
        tool_call: true,
        release_date: "2026-09-22",
        provider: { npm: "@ai-sdk/anthropic", api: "https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/anthropic/v1" },
      },
    },
  },
};

describe("opencodeProviderConfigOf", () => {
  it("gives the key variable of the provider to a model on another SDK", () => {
    expect(opencodeProviderConfigOf(AZURE, "azure/claude-opus-5-5")).toEqual({
      azure: { options: { apiKey: "{env:AZURE_API_KEY}" } },
    });
  });

  it("names nothing for a model on the provider SDK, or a provider with one variable", () => {
    expect(opencodeProviderConfigOf(AZURE, "azure/gpt-5.5")).toBeNull();
    expect(opencodeProviderConfigOf(RAW, "anthropic/claude-sonnet-5-5")).toBeNull();
    expect(opencodeProviderConfigOf(RAW, "nobody/model")).toBeNull();
  });
});

describe("ModelCatalogService", () => {
  const storeOf = (initial: StoredCatalog | null) => {
    let row = initial;
    return {
      read: () => Promise.resolve(row),
      write: (catalog: StoredCatalog) => {
        row = catalog;
        return Promise.resolve();
      },
      touch: (fetchedAt: Date) => {
        if (row !== null) row = { ...row, fetchedAt };
        return Promise.resolve();
      },
    };
  };

  it("keeps the last good copy when models.dev fails", async () => {
    const service = new ModelCatalogService({
      store: storeOf({ etag: "a", data: RAW, fetchedAt: new Date(0) }),
      source: { fetch: () => Promise.reject(new Error("offline")) },
      clock: () => 10 * 24 * 60 * 60 * 1000,
    });
    expect((await service.providers("claude"))?.providers[0]?.id).toBe("anthropic");
  });

  it("waits for the first fetch when nothing is stored, and reports none when it fails", async () => {
    const fetched = new ModelCatalogService({
      store: storeOf(null),
      source: { fetch: () => Promise.resolve({ kind: "fetched", etag: "b", data: RAW }) },
    });
    expect((await fetched.current())?.raw).toBe(RAW);
    const offline = new ModelCatalogService({ store: storeOf(null), source: { fetch: () => Promise.reject(new Error("offline")) } });
    expect(await offline.current()).toBeNull();
  });
});
