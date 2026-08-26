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
        "DATABASE_URL",
        "TEMPORAL_ADDRESS",
        "TEMPORAL_NAMESPACE",
        "SANDBOX_ADAPTER",
        "SPRITES_TOKEN",
      ].sort(),
    );
    expect(credentialsFor("full")).toHaveLength(9);
  });

  it("requires SANDBOX_ADAPTER to equal fly-sprites in the full profile", () => {
    const requirement = credentialsFor("full").find((entry) => entry.name === "SANDBOX_ADAPTER");
    expect(requirement?.kind).toBe("equals");
    expect(requirement?.value).toBe("fly-sprites");
  });

  it("keeps the local profile at exactly 8 requirements", () => {
    expect(credentialsFor("local")).toHaveLength(8);
  });

  it("requires SANDBOX_ADAPTER to equal local in the local profile", () => {
    const requirement = credentialsFor("local").find((entry) => entry.name === "SANDBOX_ADAPTER");
    expect(requirement?.kind).toBe("equals");
    expect(requirement?.value).toBe("local");
  });

  it("omits SPRITES_TOKEN from the local profile", () => {
    const names = credentialsFor("local").map((entry) => entry.name);
    expect(names).not.toContain("SPRITES_TOKEN");
  });

  it("keeps the driver credentials in every profile", () => {
    for (const profile of ["local", "sprite", "full"] as const) {
      const names = credentialsFor(profile).map((entry) => entry.name);
      expect(names).toContain("LIVE_LINEAR_API_KEY");
      expect(names).toContain("LIVE_LINEAR_TEAM_ID");
      expect(names).toContain("LIVE_GITHUB_TOKEN");
      expect(names).toContain("LIVE_GITHUB_REPOSITORY");
      expect(names).toContain("DATABASE_URL");
      expect(names).toContain("TEMPORAL_ADDRESS");
      expect(names).toContain("TEMPORAL_NAMESPACE");
    }
  });

  it("keeps the sprite profile at exactly 9 requirements, the same shape as full", () => {
    expect(credentialsFor("sprite")).toHaveLength(9);
    const requirement = credentialsFor("sprite").find((entry) => entry.name === "SANDBOX_ADAPTER");
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
