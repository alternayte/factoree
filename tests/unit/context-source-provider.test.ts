import { describe, expect, it } from "vitest";
import type {
  ContextCandidate,
  ContextDocument,
  ContextReference,
  ContextSource,
} from "~/domain/context/context-source.js";
import { ConfiguredContextSourceProvider } from "~/domain/context/context-source-provider.js";
import type {
  ContextSourceConfigurationRecord,
  ContextSourceConfigurationStore,
} from "~/domain/context/context-source-configuration.js";

const stub = (id: string): ContextSource => ({
  id: () => id,
  discover: (): Promise<ContextCandidate[]> => Promise.resolve([]),
  fetch: (reference: ContextReference): Promise<ContextDocument> =>
    Promise.resolve({ reference, sourceVersion: "1", content: "" }),
});

const record = (
  over: Partial<ContextSourceConfigurationRecord>,
): ContextSourceConfigurationRecord => ({
  id: "row",
  tenantId: "tenant",
  productId: "product",
  sourceId: "backstage",
  kind: "backstage",
  enabled: true,
  endpoint: "https://backstage.test",
  secretName: null,
  settings: { kind: "backstage", primaryComponent: null, maxEntities: 50, includeOwnership: true },
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const storeOf = (rows: ContextSourceConfigurationRecord[]): ContextSourceConfigurationStore => ({
  put: () => Promise.reject(new Error("unused")),
  list: () => Promise.resolve(rows),
  remove: () => Promise.resolve(false),
  lastReads: () => Promise.resolve(new Map()),
});

const providerOf = (
  rows: ContextSourceConfigurationRecord[],
  secrets: Record<string, string> = {},
): ConfiguredContextSourceProvider =>
  new ConfiguredContextSourceProvider({
    configurations: storeOf(rows),
    secrets: { read: (_tenantId, _productId, name) => Promise.resolve(secrets[name] ?? null) },
    fixedSources: () => [stub("linear"), stub("repository")],
    factories: {
      backstage: (row) => stub(row.sourceId),
      mcp: (row) => stub(row.sourceId),
      llms_txt: (row) => stub(row.sourceId),
    },
  });

const scope = (over: Partial<{ backstageEnabled: boolean; automaticReferenceDiscovery: boolean }> = {}) => ({
  tenantId: "tenant",
  productId: "product",
  contextConfiguration: {
    backstageEnabled: true,
    automaticReferenceDiscovery: false,
    ...over,
  },
});

describe("ConfiguredContextSourceProvider", () => {
  it("always registers the built-in sources", async () => {
    const registry = await providerOf([]).sourcesFor(scope());
    expect(registry.ids()).toEqual(["linear", "repository"]);
  });

  it("adds a configured Backstage source when the repository opts in", async () => {
    const registry = await providerOf([record({})]).sourcesFor(scope());
    expect(registry.ids()).toEqual(["backstage", "linear", "repository"]);
  });

  it("leaves Backstage out when the repository does not opt in", async () => {
    const registry = await providerOf([record({})]).sourcesFor(scope({ backstageEnabled: false }));
    expect(registry.ids()).toEqual(["linear", "repository"]);
  });

  it("leaves a disabled row out", async () => {
    const registry = await providerOf([record({ enabled: false })]).sourcesFor(scope());
    expect(registry.ids()).toEqual(["linear", "repository"]);
  });

  it("adds an MCP source without a repository switch, because SDD section 15 defines none", async () => {
    const rows = [
      record({
        sourceId: "docs",
        kind: "mcp",
        settings: {
          kind: "mcp",
          discoverTool: "search",
          fetchTool: "read",
          allowedTools: ["read", "search"],
          authority: "prose_documentation",
          maxCandidates: 20,
        },
      }),
    ];
    const registry = await providerOf(rows).sourcesFor(scope({ backstageEnabled: false }));
    expect(registry.ids()).toEqual(["docs", "linear", "repository"]);
  });

  it("leaves out a row whose named secret does not exist", async () => {
    const registry = await providerOf([record({ secretName: "MISSING" })]).sourcesFor(scope());
    expect(registry.ids()).toEqual(["linear", "repository"]);
  });
});
