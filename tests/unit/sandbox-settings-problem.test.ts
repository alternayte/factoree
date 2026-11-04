import { afterEach, describe, expect, it } from "vitest";
import { buildInfo } from "~/config/build-info.js";
import { sandboxSettingsProblem } from "~/http/admin/schemas.js";
import type { SandboxSettings } from "~/domain/settings/install-settings.js";

// DI-15.11. A released image pins its sandbox image, so a Kiln install needs no image entry.
// A build from a checkout pins none, and Kiln then needs the override.
const kiln: SandboxSettings = {
  provider: "kiln",
  url: "https://kiln.example.com",
  apiKey: "kiln-key",
  image: null,
  registryUsername: null,
  registryToken: null,
  maxLive: null,
  vcpus: null,
  memoryMb: null,
};

const pinned = "ghcr.io/alternayte/factoree-sandbox@sha256:" + "a".repeat(64);
const original = buildInfo.sandboxImageDefault;

afterEach(() => {
  buildInfo.sandboxImageDefault = original;
});

describe("sandboxSettingsProblem and the pinned sandbox image", () => {
  it("accepts Kiln with no image when the build pins one", () => {
    buildInfo.sandboxImageDefault = pinned;
    expect(sandboxSettingsProblem(kiln, false)).toBeNull();
  });

  it("refuses Kiln with no image when the build pins none", () => {
    buildInfo.sandboxImageDefault = null;
    expect(sandboxSettingsProblem(kiln, false)).toMatch(/pins no sandbox image/);
  });

  it("refuses E2B without an API key, and accepts it with no URL", () => {
    buildInfo.sandboxImageDefault = pinned;
    const e2b: SandboxSettings = { ...kiln, provider: "e2b", url: null, apiKey: "e2b-key" };
    expect(sandboxSettingsProblem(e2b, false)).toBeNull();
    expect(sandboxSettingsProblem({ ...e2b, apiKey: null }, false)).toBe("E2B needs an API key");
  });

  it("accepts the override when the build pins none", () => {
    buildInfo.sandboxImageDefault = null;
    expect(sandboxSettingsProblem({ ...kiln, image: pinned }, false)).toBeNull();
  });
});
