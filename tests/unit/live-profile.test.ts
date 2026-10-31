import { describe, expect, it } from "vitest";
import { PROFILE_BANNER, credentialsFor, resolveProfile } from "../live/profile.js";

/**
 * This anti-weakening guard changed deliberately in the env cleanup. The old full list named
 * fourteen `LIVE_*` and `LIVE_LOCAL_*` names, and most of them were a gate nothing read. The
 * new list names only values `src/config/env.ts` or `tests/live/scenario.ts` genuinely consume.
 * It is a STRONGER requirement, not a weaker one, because every name on it is load-bearing. A
 * future edit must not shrink what `full` demands below this list.
 */
describe("the live acceptance profile split", () => {
  it("keeps the full profile at exactly the current 9 requirements", () => {
    const names = credentialsFor("full")
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual(
      [
        "LIVE_LINEAR_API_KEY",
        "LIVE_LINEAR_TEAM_ID",
        "LIVE_GITHUB_TOKEN",
        "LIVE_GITHUB_REPOSITORY",
        "FACTOREE_DATABASE_URL",
        "FACTOREE_TEMPORAL_ADDRESS",
        "FACTOREE_TEMPORAL_NAMESPACE",
        "install.sandbox.provider",
        "install.sandbox.apiKey",
      ].sort(),
    );
    expect(credentialsFor("full")).toHaveLength(9);
  });

  it("swaps only the Sprite requirements for the Kiln ones when the full profile runs on Kiln", () => {
    const names = credentialsFor("full", { "install.sandbox.provider": "kiln" })
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual(
      [
        "LIVE_LINEAR_API_KEY",
        "LIVE_LINEAR_TEAM_ID",
        "LIVE_GITHUB_TOKEN",
        "LIVE_GITHUB_REPOSITORY",
        "FACTOREE_DATABASE_URL",
        "FACTOREE_TEMPORAL_ADDRESS",
        "FACTOREE_TEMPORAL_NAMESPACE",
        "install.sandbox.provider",
        "install.sandbox.url",
        "install.sandbox.apiKey",
        "install.sandbox.image",
      ].sort(),
    );
    const requirement = credentialsFor("full", { "install.sandbox.provider": "kiln" }).find((entry) => entry.name === "install.sandbox.provider");
    expect(requirement?.value).toBe("kiln");
  });

  it("requires the install settings to name fly-sprites in the full profile", () => {
    const requirement = credentialsFor("full").find((entry) => entry.name === "install.sandbox.provider");
    expect(requirement?.kind).toBe("equals");
    expect(requirement?.value).toBe("fly-sprites");
  });

  // docs/specs/release-0-1-0.md. The local profile also demands FACTOREE_UNSAFE_LOCAL_SANDBOX, which
  // the worker needs before it accepts the local provider of the install settings.
  it("keeps the local profile at exactly 9 requirements", () => {
    expect(credentialsFor("local")).toHaveLength(9);
    const optIn = credentialsFor("local").find((entry) => entry.name === "FACTOREE_UNSAFE_LOCAL_SANDBOX");
    expect(optIn?.value).toBe("1");
  });

  it("requires the install settings to name local in the local profile", () => {
    const requirement = credentialsFor("local").find((entry) => entry.name === "install.sandbox.provider");
    expect(requirement?.kind).toBe("equals");
    expect(requirement?.value).toBe("local");
  });

  it("omits the sandbox key from the local profile", () => {
    const names = credentialsFor("local").map((entry) => entry.name);
    expect(names).not.toContain("install.sandbox.apiKey");
  });

  it("keeps the driver credentials in every profile", () => {
    for (const profile of ["local", "sprite", "full"] as const) {
      const names = credentialsFor(profile).map((entry) => entry.name);
      expect(names).toContain("LIVE_LINEAR_API_KEY");
      expect(names).toContain("LIVE_LINEAR_TEAM_ID");
      expect(names).toContain("LIVE_GITHUB_TOKEN");
      expect(names).toContain("LIVE_GITHUB_REPOSITORY");
      expect(names).toContain("FACTOREE_DATABASE_URL");
      expect(names).toContain("FACTOREE_TEMPORAL_ADDRESS");
      expect(names).toContain("FACTOREE_TEMPORAL_NAMESPACE");
    }
  });

  it("keeps the sprite profile at exactly 9 requirements, the same shape as full", () => {
    expect(credentialsFor("sprite")).toHaveLength(9);
    const requirement = credentialsFor("sprite").find((entry) => entry.name === "install.sandbox.provider");
    expect(requirement?.kind).toBe("equals");
    expect(requirement?.value).toBe("fly-sprites");
  });

  it("resolves a missing profile variable to full, the strict profile", () => {
    expect(resolveProfile({})).toBe("full");
  });

  it("resolves the local profile when the variable states it", () => {
    expect(resolveProfile({ FACTOREE_LIVE_PROFILE: "local" })).toBe("local");
  });

  it("resolves the sprite profile when the variable states it", () => {
    expect(resolveProfile({ FACTOREE_LIVE_PROFILE: "sprite" })).toBe("sprite");
  });

  it("throws on an unknown profile value", () => {
    expect(() => resolveProfile({ FACTOREE_LIVE_PROFILE: "nonsense" })).toThrow();
  });

  it("marks the local banner as not SDD section 66 proof", () => {
    expect(PROFILE_BANNER.local).toContain("NOT SDD SECTION 66 PROOF");
  });

  it("marks the sprite banner as not SDD section 66 proof", () => {
    expect(PROFILE_BANNER.sprite).toContain("NOT SDD SECTION 66 PROOF");
  });

  it("keeps the full banner free of the local disclaimer", () => {
    expect(PROFILE_BANNER.full).not.toContain("NOT SDD SECTION 66 PROOF");
  });
});
