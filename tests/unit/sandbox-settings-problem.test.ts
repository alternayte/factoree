import { afterEach, describe, expect, it } from "vitest";
import { buildInfo } from "~/config/build-info.js";
import { sandboxProviderProblem } from "~/http/admin/schemas.js";
import type { SandboxProviderSettings } from "~/domain/settings/sandbox-providers.js";

// DI-15.11. A released image pins its sandbox image, so a Kiln provider needs no image entry.
// A build from a checkout pins none, and Kiln then needs the install override.
const kiln: Pick<SandboxProviderSettings, "type" | "url" | "apiKey"> = {
  type: "kiln",
  url: "https://kiln.example.com",
  apiKey: "kiln-key",
};

const pinned = "ghcr.io/alternayte/factoree-sandbox@sha256:" + "a".repeat(64);
const original = buildInfo.sandboxImageDefault;

afterEach(() => {
  buildInfo.sandboxImageDefault = original;
});

describe("sandboxProviderProblem and the pinned sandbox image", () => {
  it("accepts Kiln with no image when the build pins one", () => {
    buildInfo.sandboxImageDefault = pinned;
    expect(sandboxProviderProblem(kiln, null, false)).toBeNull();
  });

  it("refuses Kiln with no image when the build pins none", () => {
    buildInfo.sandboxImageDefault = null;
    expect(sandboxProviderProblem(kiln, null, false)).toMatch(/pins no sandbox image/);
  });

  it("refuses E2B without an API key, and accepts it with no URL", () => {
    buildInfo.sandboxImageDefault = pinned;
    const e2b = { ...kiln, type: "e2b" as const, url: null, apiKey: "e2b-key" };
    expect(sandboxProviderProblem(e2b, null, false)).toBeNull();
    expect(sandboxProviderProblem({ ...e2b, apiKey: null }, null, false)).toBe("E2B needs an API key");
  });

  it("accepts the install override when the build pins none", () => {
    buildInfo.sandboxImageDefault = null;
    expect(sandboxProviderProblem(kiln, pinned, false)).toBeNull();
  });
});
