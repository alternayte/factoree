import { describe, expect, it } from "vitest";
import {
  isPreviewRelativePath,
  PreviewUrlError,
  resolvePreviewUrl,
} from "~/domain/validation/preview-url.js";

const BASE = "http://127.0.0.1:8080";

/** The paths a WHATWG URL parser can read as the start of an authority. */
const ORIGIN_ESCAPES = ["//example.com", "///example.com", "/\\example.com", "/\\\\example.com"];

describe("isPreviewRelativePath", () => {
  it("accepts a bare slash", () => {
    expect(isPreviewRelativePath("/")).toBe(true);
  });

  it("accepts an ordinary relative path", () => {
    expect(isPreviewRelativePath("/projects/1?q=2#a")).toBe(true);
  });

  it("rejects a path that does not begin with a slash", () => {
    expect(isPreviewRelativePath("projects/1")).toBe(false);
    expect(isPreviewRelativePath("http://example.com/")).toBe(false);
  });

  it.each(ORIGIN_ESCAPES)("rejects %s", (path) => {
    expect(isPreviewRelativePath(path)).toBe(false);
  });
});

describe("resolvePreviewUrl", () => {
  it("resolves a relative path against the preview base URL", () => {
    expect(resolvePreviewUrl(BASE, "/projects/1")).toBe("http://127.0.0.1:8080/projects/1");
    expect(resolvePreviewUrl(BASE, "/")).toBe("http://127.0.0.1:8080/");
  });

  it.each(ORIGIN_ESCAPES)("refuses %s, which resolves to a foreign origin", (path) => {
    // The bare URL parser proves the danger. The guard must refuse exactly this.
    const naive = new URL(path, BASE);
    expect(naive.origin).not.toBe(new URL(BASE).origin);
    expect(() => resolvePreviewUrl(BASE, path)).toThrow(PreviewUrlError);
  });

  it("refuses an absolute URL that names another host", () => {
    expect(() => resolvePreviewUrl(BASE, "http://example.com/")).toThrow(PreviewUrlError);
  });

  it("refuses a base URL that is not a valid URL", () => {
    expect(() => resolvePreviewUrl("not a url", "/projects/1")).toThrow(PreviewUrlError);
  });

  it("never returns a URL whose origin differs from the preview origin", () => {
    for (const path of ["/", "/projects/1", ...ORIGIN_ESCAPES]) {
      let resolved: string | null = null;
      try {
        resolved = resolvePreviewUrl(BASE, path);
      } catch {
        resolved = null;
      }
      if (resolved !== null) {
        expect(new URL(resolved).origin).toBe("http://127.0.0.1:8080");
      }
    }
  });
});
