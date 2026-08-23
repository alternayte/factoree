import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { McpJsonRpcClient } from "~/adapters/mcp/mcp-json-rpc-client.js";
import type { ResolvedContext } from "~/domain/context/context-resolver.js";
import { ContextSourceRegistry } from "~/domain/context/context-source-registry.js";
import { parseContextSourceSettings } from "~/domain/context/context-source-configuration.js";
import type { McpSourceSettings } from "~/domain/context/context-source-configuration.js";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import { McpContextSource } from "~/domain/context/mcp-source.js";
import { RepositoryContextSource } from "~/domain/context/repository-source.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import type { ContextFixture } from "./support/context-fixture-repository.js";
import { buildContextFixture } from "./support/context-fixture-repository.js";
import type { McpFixtureServer } from "./support/mcp-fixture-server.js";
import { MCP_FIXTURE_ITEM_REF } from "./support/mcp-fixture-server.js";
import { start } from "./support/mcp-fixture-server.js";
import { resolveFixtureContext } from "./support/resolve-fixture-context.js";

let fixture: ContextFixture;
let server: McpFixtureServer;
let resolved: ResolvedContext;
const reader = new GitRepositoryReader();

const buildMcpSource = (settings: McpSourceSettings): McpContextSource =>
  new McpContextSource({
    sourceId: "docs",
    settings,
    policy: buildActionPolicy({ mcpAllowedTools: settings.allowedTools }),
    tools: new McpJsonRpcClient({ endpoint: server.url, token: null, fetch }),
  });

/**
 * Resolves the fixture Project against a fresh MCP source of the given allow list, over the
 * same real server. SDD section 58's gate is exercised for real: an empty allow list is the
 * `ActionPolicy` the specification asks for, built with `buildActionPolicy`, never with the
 * `new ActionPolicy(...)` sketch of the brief — the Action Policy is a factory function.
 */
const resolveWithMcp = (options: { allowedTools: string[] }): Promise<ResolvedContext> => {
  const settings: McpSourceSettings = {
    kind: "mcp",
    discoverTool: "search_docs",
    fetchTool: "read_doc",
    allowedTools: options.allowedTools,
    authority: "prose_documentation",
    maxCandidates: 20,
  };
  const sources = new ContextSourceRegistry([
    new LinearContextSource(),
    new RepositoryContextSource({ reader }),
    buildMcpSource(settings),
  ]);
  return resolveFixtureContext({
    fixture,
    reader,
    runId: `run-at-36-${options.allowedTools.length}`,
    sources,
  });
};

beforeAll(async () => {
  fixture = await buildContextFixture();
  server = await start();

  const settings = parseContextSourceSettings("mcp", {
    discoverTool: "search_docs",
    fetchTool: "read_doc",
  }) as McpSourceSettings;
  const sources = new ContextSourceRegistry([
    new LinearContextSource(),
    new RepositoryContextSource({ reader }),
    buildMcpSource(settings),
  ]);
  resolved = await resolveFixtureContext({ fixture, reader, runId: "run-at-36", sources });
});

afterAll(async () => {
  reader.close();
  fixture.cleanup();
  await server.close();
});

/**
 * AT-36. A configured test MCP source supplies a Context Candidate with provenance. The server
 * is a real HTTP server, so the JSON-RPC client is exercised end to end.
 */
describe("AT-36 — the MCP context source", () => {
  it("supplies one candidate with full provenance and reaches the Context Contract", () => {
    const item = resolved.contract.items.find((candidate) => candidate.reference.sourceId === "docs");
    expect(item).toBeDefined();
    expect(item?.reference.ref).toBe(`docs:${MCP_FIXTURE_ITEM_REF}`);
    expect(item?.sourceVersion).toBe("2026-02-01T00:00:00Z");
    expect(item?.authority).toBe("prose_documentation");
    expect(item?.reason).toContain('the MCP source "docs" reports:');
    expect(["required", "reference"]).toContain(item?.classification);
    expect(resolved.document).toContain(`docs:${MCP_FIXTURE_ITEM_REF}`);
  });

  it("makes exactly the two allow-listed tool calls and no other", () => {
    expect(server.calls.filter((call) => call.tool !== null).map((call) => call.tool)).toEqual([
      "search_docs",
      "read_doc",
    ]);
  });

  it("refuses a tool the Project did not allow-list, and the Run still resolves", async () => {
    // SDD section 58. The same server, a settings block whose allow list names neither tool.
    const denied = await resolveWithMcp({ allowedTools: [] });
    expect(denied.contract.items.some((item) => item.reference.sourceId === "docs")).toBe(false);
    expect(denied.unresolvedConflict).toBeNull();
  });
});
