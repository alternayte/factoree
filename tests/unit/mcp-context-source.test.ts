import { describe, expect, it } from "vitest";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { McpContextSource } from "~/domain/context/mcp-source.js";
import { DISCOVERY_PRIORITY } from "~/domain/context/context-source.js";
import { DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION } from "~/domain/context/repository-context-configuration.js";

const SETTINGS = {
  kind: "mcp" as const,
  discoverTool: "search_docs",
  fetchTool: "read_doc",
  allowedTools: ["read_doc", "search_docs"],
  authority: "prose_documentation" as const,
  maxCandidates: 20,
};

const request = {
  runId: "run-1",
  goal: "Retry a failed notification.",
  topics: ["notification", "retry", "urgent"],
  primaryRepository: { slug: "acme/app", url: "https://git.test/acme/app.git", ref: "main" },
  referenceRepositories: [],
  workItemReferences: [],
  decisions: [],
  contextConfiguration: DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION,
};

const ANSWER = JSON.stringify({
  items: [
    {
      ref: "runbook/notification-retry",
      title: "Notification retry runbook",
      sourceVersion: "2026-02-01T00:00:00Z",
      reason: "the internal runbook for notification retry",
      sizeBytes: 1200,
    },
  ],
});

const sourceOf = (
  calls: Array<{ name: string; args: unknown }>,
  answers: Record<string, string>,
  policy = buildActionPolicy({ mcpAllowedTools: SETTINGS.allowedTools }),
) =>
  new McpContextSource({
    sourceId: "docs",
    settings: SETTINGS,
    policy,
    tools: {
      callTool: (name, args) => {
        calls.push({ name, args });
        const answer = answers[name];
        return answer === undefined ? Promise.reject(new Error(`no answer for ${name}`)) : Promise.resolve(answer);
      },
    },
  });

describe("McpContextSource", () => {
  it("offers a candidate with the provenance SDD section 21 requires", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const [candidate] = await sourceOf(calls, { search_docs: ANSWER }).discover(request);
    expect(candidate?.reference).toEqual({
      sourceId: "docs",
      ref: "docs:runbook/notification-retry",
      repository: null,
      sha: null,
      path: null,
    });
    expect(candidate?.sourceVersion).toBe("2026-02-01T00:00:00Z");
    expect(candidate?.authority).toBe("prose_documentation");
    expect(candidate?.reason).toBe(
      'the MCP source "docs" reports: the internal runbook for notification retry',
    );
    expect(candidate?.priority).toBe(DISCOVERY_PRIORITY.scoped_semantic_search);
    expect(candidate?.suggestedClassification).toBe("reference");
    // Deviation from the brief: its fixture's title ("Notification retry runbook") and reason
    // ("the internal runbook for notification retry") both literally contain "retry", so the
    // substring topic match used by every other source (backstage-source.ts,
    // repository-source.ts) necessarily reports both topics, not just "notification". The
    // request adds "urgent", which appears in neither field, so this assertion proves real
    // filtering: the requested topics that are present pass through, and the one that is not
    // present in the item text is excluded.
    expect(candidate?.topics).toEqual(["notification", "retry"]);
    expect(candidate?.topics).not.toContain("urgent");
    expect(calls[0]).toEqual({
      name: "search_docs",
      args: { goal: request.goal, topics: request.topics, repository: "acme/app" },
    });
  });

  it("refuses to call a tool the Action Policy denies, and reports no candidate", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const candidates = await sourceOf(calls, { search_docs: ANSWER }, buildActionPolicy({})).discover(request);
    expect(candidates).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("stops at the candidate cap", async () => {
    const many = JSON.stringify({
      items: Array.from({ length: 30 }, (_, index) => ({
        ref: `doc-${index}`,
        sourceVersion: "1",
        reason: "a document",
      })),
    });
    const candidates = await sourceOf([], { search_docs: many }).discover(request);
    expect(candidates).toHaveLength(SETTINGS.maxCandidates);
  });

  it("drops an item that has no reference or no source version", async () => {
    const broken = JSON.stringify({ items: [{ title: "no ref" }, { ref: "a", title: "no version" }] });
    expect(await sourceOf([], { search_docs: broken }).discover(request)).toEqual([]);
  });

  it("keeps the Run alive when the server fails", async () => {
    expect(await sourceOf([], {}).discover(request)).toEqual([]);
  });

  it("fetches a document through the fetch tool", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const source = sourceOf(calls, { search_docs: ANSWER, read_doc: "retry after ten minutes" });
    await source.discover(request);
    const document = await source.fetch({
      sourceId: "docs",
      ref: "docs:runbook/notification-retry",
      repository: null,
      sha: null,
      path: null,
    });
    expect(document.content).toBe("retry after ten minutes");
    expect(calls[1]).toEqual({ name: "read_doc", args: { ref: "runbook/notification-retry" } });
  });

  it("refuses to fetch a tool the Action Policy denies, and calls no tool", async () => {
    // SDD section 58. The allow list names the discovery tool only, so the fetch tool is denied.
    const calls: Array<{ name: string; args: unknown }> = [];
    const source = sourceOf(
      calls,
      { search_docs: ANSWER, read_doc: "retry after ten minutes" },
      buildActionPolicy({ mcpAllowedTools: ["search_docs"] }),
    );
    await source.discover(request);
    await expect(
      source.fetch({
        sourceId: "docs",
        ref: "docs:runbook/notification-retry",
        repository: null,
        sha: null,
        path: null,
      }),
    ).rejects.toThrow(/read_doc/);
    expect(calls.map((call) => call.name)).toEqual(["search_docs"]);
  });

  it("refuses a fetch for a reference it never offered", async () => {
    const source = sourceOf([], { search_docs: ANSWER });
    await source.discover(request);
    await expect(
      source.fetch({ sourceId: "docs", ref: "docs:other", repository: null, sha: null, path: null }),
    ).rejects.toThrow(/never offered/);
  });
});
