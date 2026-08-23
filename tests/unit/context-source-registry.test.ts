import { describe, expect, it } from "vitest";
import {
  ContextSourceRegistry,
  UnknownContextSourceError,
} from "~/domain/context/context-source-registry.js";
import type { ContextSource } from "~/domain/context/context-source.js";

const stub = (id: string): ContextSource => ({
  id: () => id,
  discover: () => Promise.resolve([]),
  fetch: () => Promise.reject(new Error("not used")),
});

describe("ContextSourceRegistry", () => {
  it("returns a registered source by its identifier", () => {
    const source = stub("linear");
    expect(new ContextSourceRegistry([source]).get("linear")).toBe(source);
  });

  it("lists every identifier in sorted order", () => {
    const registry = new ContextSourceRegistry([stub("repository"), stub("linear")]);
    expect(registry.ids()).toEqual(["linear", "repository"]);
  });

  it("returns every source in identifier order", () => {
    const registry = new ContextSourceRegistry([stub("repository"), stub("linear")]);
    expect(registry.all().map((source) => source.id())).toEqual(["linear", "repository"]);
  });

  it("refuses a duplicate identifier", () => {
    expect(() => new ContextSourceRegistry([stub("linear"), stub("linear")])).toThrow(/already registered/);
  });

  it("throws a named error for an unknown identifier", () => {
    expect(() => new ContextSourceRegistry([stub("linear")]).get("backstage")).toThrow(
      UnknownContextSourceError,
    );
  });

  it("names the registered identifiers in the error message", () => {
    expect(() => new ContextSourceRegistry([stub("linear")]).get("backstage")).toThrow(/linear/);
  });
});
