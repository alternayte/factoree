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
    expect(storageNameOf("VAL-UI-001", artifact({}))).toBe("VAL-UI-001-screenshot.png");
  });

  it("never keeps a colon or a path separator", () => {
    const name = storageNameOf("VAL/UI:001", artifact({ kind: "assertion-log", contentType: "application/json" }));
    expect(name).toBe("VAL-UI-001-assertion-log.json");
    expect(name).not.toContain(":");
    expect(name).not.toContain("/");
  });

  it("maps the video and trace content types", () => {
    expect(storageNameOf("VAL-UI-001", artifact({ kind: "video", contentType: "video/webm" }))).toBe(
      "VAL-UI-001-video.webm",
    );
    expect(storageNameOf("VAL-UI-001", artifact({ kind: "trace", contentType: "application/zip" }))).toBe(
      "VAL-UI-001-trace.zip",
    );
  });

  it("reads the media type of a content type that carries a parameter", () => {
    expect(
      storageNameOf("VAL-API-001", artifact({ kind: "request-response", contentType: "application/json; charset=utf-8" })),
    ).toBe("VAL-API-001-request-response.json");
  });

  it("gives an unknown content type the bin extension", () => {
    expect(storageNameOf("VAL-UI-001", artifact({ kind: "console", contentType: "application/x-odd" }))).toBe(
      "VAL-UI-001-console.bin",
    );
  });
});
