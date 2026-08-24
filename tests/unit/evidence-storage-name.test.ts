import { describe, expect, it } from "vitest";
import { storageNameOf } from "~/activities/evidence.activities.js";
import type { EvidenceArtifact } from "~/domain/validation/validation-result.js";

const artifact = (overrides: Partial<EvidenceArtifact>): EvidenceArtifact => ({
  kind: "screenshot",
  source: "browser:VAL-UI-001:screenshot",
  contentType: "image/png",
  bytes: new Uint8Array([1]),
  metadata: {},
  ...overrides,
});

describe("storageNameOf", () => {
  it("builds a safe file name with the extension of the content type", () => {
    expect(storageNameOf("VAL-UI-001", artifact({}))).toBe(
      "VAL-UI-001-browser-VAL-UI-001-screenshot.png",
    );
  });

  it("never keeps a colon or a path separator", () => {
    const name = storageNameOf(
      "VAL/UI:001",
      artifact({
        kind: "assertion-log",
        source: "browser:VAL-UI-001:assertion-log",
        contentType: "application/json",
      }),
    );
    expect(name).toBe("VAL-UI-001-browser-VAL-UI-001-assertion-log.json");
    expect(name).not.toContain(":");
    expect(name).not.toContain("/");
  });

  it("maps the video and trace content types", () => {
    expect(
      storageNameOf(
        "VAL-UI-001",
        artifact({ kind: "video", source: "browser:VAL-UI-001:video:final", contentType: "video/webm" }),
      ),
    ).toBe("VAL-UI-001-browser-VAL-UI-001-video-final.webm");
    expect(
      storageNameOf(
        "VAL-UI-001",
        artifact({ kind: "trace", source: "browser:VAL-UI-001:trace", contentType: "application/zip" }),
      ),
    ).toBe("VAL-UI-001-browser-VAL-UI-001-trace.zip");
  });

  it("reads the media type of a content type that carries a parameter", () => {
    expect(
      storageNameOf(
        "VAL-API-001",
        artifact({
          kind: "request-response",
          source: "http:VAL-API-001",
          contentType: "application/json; charset=utf-8",
        }),
      ),
    ).toBe("VAL-API-001-http-VAL-API-001.json");
  });

  it("gives an unknown content type the bin extension", () => {
    expect(
      storageNameOf(
        "VAL-UI-001",
        artifact({ kind: "console", source: "browser:VAL-UI-001:console", contentType: "application/x-odd" }),
      ),
    ).toBe("VAL-UI-001-browser-VAL-UI-001-console.bin");
  });

  it("gives two same-kind artefacts of one assertion two different storage names", () => {
    // A named screenshot and the browser driver's own `final` screenshot share one assertion
    // and one kind. The evidence row already tells them apart by `source`. The storage name
    // must now tell them apart too, so no artefact silently overwrites another.
    const named = storageNameOf(
      "VAL-UI-001",
      artifact({ kind: "screenshot", source: "browser:VAL-UI-001:screenshot:login-form" }),
    );
    const final = storageNameOf(
      "VAL-UI-001",
      artifact({ kind: "screenshot", source: "browser:VAL-UI-001:screenshot:final" }),
    );
    expect(named).not.toBe(final);
  });
});
