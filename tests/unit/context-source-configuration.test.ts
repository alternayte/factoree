import { describe, expect, it } from "vitest";
import {
  RESERVED_CONTEXT_SOURCE_IDS,
  assertContextSourceId,
  parseContextSourceSettings,
} from "~/domain/context/context-source-configuration.js";

describe("parseContextSourceSettings", () => {
  it("gives a Backstage source its bounded defaults", () => {
    const settings = parseContextSourceSettings("backstage", {});
    expect(settings).toEqual({
      kind: "backstage",
      primaryComponent: null,
      maxEntities: 50,
      includeOwnership: true,
    });
  });

  it("rejects an unknown Backstage key", () => {
    expect(() => parseContextSourceSettings("backstage", { catalogWide: true })).toThrow(
      /catalogWide/,
    );
  });

  it("rejects an entity cap above the ceiling", () => {
    expect(() => parseContextSourceSettings("backstage", { maxEntities: 5000 })).toThrow(
      /maxEntities/,
    );
  });

  it("requires the two MCP tool names", () => {
    expect(() => parseContextSourceSettings("mcp", {})).toThrow(/discoverTool/);
  });

  it("allow-lists the two MCP tools it uses", () => {
    const settings = parseContextSourceSettings("mcp", {
      discoverTool: "search_docs",
      fetchTool: "read_doc",
    });
    expect(settings).toEqual({
      kind: "mcp",
      discoverTool: "search_docs",
      fetchTool: "read_doc",
      allowedTools: ["read_doc", "search_docs"],
      authority: "prose_documentation",
      maxCandidates: 20,
    });
  });

  it("rejects an authority class the SDD does not define", () => {
    expect(() =>
      parseContextSourceSettings("mcp", {
        discoverTool: "a",
        fetchTool: "b",
        authority: "gut_feeling",
      }),
    ).toThrow(/authority/);
  });

  it("keeps an extra allow-listed tool and still holds the two it calls", () => {
    const settings = parseContextSourceSettings("mcp", {
      discoverTool: "search_docs",
      fetchTool: "read_doc",
      allowedTools: ["ping"],
    });
    expect(settings).toEqual({
      kind: "mcp",
      discoverTool: "search_docs",
      fetchTool: "read_doc",
      allowedTools: ["ping", "read_doc", "search_docs"],
      authority: "prose_documentation",
      maxCandidates: 20,
    });
  });
});

describe("assertContextSourceId", () => {
  it("accepts a namespaced identifier", () => {
    expect(() => assertContextSourceId("mcp:internal-docs")).not.toThrow();
  });

  it("refuses an identifier a built-in source already owns", () => {
    for (const id of RESERVED_CONTEXT_SOURCE_IDS) {
      expect(() => assertContextSourceId(id)).toThrow(/reserved/);
    }
  });

  it("refuses an identifier with a space", () => {
    expect(() => assertContextSourceId("my source")).toThrow(/lower case/);
  });
});
