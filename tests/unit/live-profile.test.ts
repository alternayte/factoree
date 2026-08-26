import { describe, expect, it } from "vitest";
import {
  PROFILE_BANNER,
  credentialsFor,
  resolveProfile,
} from "../live/profile.js";
import { REQUIRED_LIVE_CREDENTIALS } from "../live/required-credentials.js";

describe("the live acceptance profile split", () => {
  it("keeps the full profile at exactly the current 14 credentials", () => {
    // The anti-weakening guard. A future edit that drops a full credential fails here.
    const names = credentialsFor("full")
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual(
      [
        "LIVE_BACKSTAGE_BASE_URL",
        "LIVE_BACKSTAGE_TOKEN",
        "LIVE_FLY_API_TOKEN",
        "LIVE_FLY_ORGANIZATION",
        "LIVE_GITHUB_REPOSITORY",
        "LIVE_GITHUB_TOKEN",
        "LIVE_LINEAR_API_KEY",
        "LIVE_LINEAR_TEAM_ID",
        "LIVE_MCP_ENDPOINT",
        "LIVE_MCP_TOKEN",
        "LIVE_RUNNER_API_KEY",
        "LIVE_RUNNER_NAME",
        "LIVE_TEMPORAL_ADDRESS",
        "LIVE_TEMPORAL_NAMESPACE",
      ].sort(),
    );
    expect(credentialsFor("full")).toHaveLength(REQUIRED_LIVE_CREDENTIALS.length);
    expect(credentialsFor("full")).toHaveLength(14);
  });

  it("omits every Fly and Temporal Cloud credential from the local profile", () => {
    const local = credentialsFor("local");
    const flyNames = local.filter((entry) => entry.dependency === "fly-sprites");
    expect(flyNames).toEqual([]);
    const temporalNames = local
      .filter((entry) => entry.dependency === "temporal")
      .map((entry) => entry.name);
    expect(temporalNames).not.toContain("LIVE_TEMPORAL_ADDRESS");
    expect(temporalNames).not.toContain("LIVE_TEMPORAL_NAMESPACE");
  });

  it("keeps the real Linear and GitHub credentials in the local profile", () => {
    const names = credentialsFor("local").map((entry) => entry.name);
    expect(names).toContain("LIVE_LINEAR_API_KEY");
    expect(names).toContain("LIVE_LINEAR_TEAM_ID");
    expect(names).toContain("LIVE_GITHUB_TOKEN");
    expect(names).toContain("LIVE_GITHUB_REPOSITORY");
  });

  it("resolves a missing profile variable to full, the strict profile", () => {
    expect(resolveProfile({})).toBe("full");
  });

  it("resolves the local profile when the variable states it", () => {
    expect(resolveProfile({ FACTOREE_LIVE_PROFILE: "local" })).toBe("local");
  });

  it("throws on an unknown profile value", () => {
    expect(() => resolveProfile({ FACTOREE_LIVE_PROFILE: "nonsense" })).toThrow();
  });

  it("marks the local banner as not SDD section 66 proof", () => {
    expect(PROFILE_BANNER.local).toContain("NOT SDD SECTION 66 PROOF");
  });

  it("keeps the full banner free of the local disclaimer", () => {
    expect(PROFILE_BANNER.full).not.toContain("NOT SDD SECTION 66 PROOF");
  });

  it("keeps the sprite profile at exactly 12 credentials", () => {
    expect(credentialsFor("sprite")).toHaveLength(12);
  });

  it("keeps the real Fly Sprite credentials in the sprite profile", () => {
    const names = credentialsFor("sprite").map((entry) => entry.name);
    expect(names).toContain("LIVE_FLY_API_TOKEN");
    expect(names).toContain("LIVE_FLY_ORGANIZATION");
  });

  it("omits every Temporal Cloud credential from the sprite profile", () => {
    const temporalNames = credentialsFor("sprite")
      .filter((entry) => entry.dependency === "temporal")
      .map((entry) => entry.name);
    expect(temporalNames).not.toContain("LIVE_TEMPORAL_ADDRESS");
    expect(temporalNames).not.toContain("LIVE_TEMPORAL_NAMESPACE");
  });

  it("makes the sprite profile a strict superset of the local profile", () => {
    const localNames = new Set(credentialsFor("local").map((entry) => entry.name));
    const spriteNames = new Set(credentialsFor("sprite").map((entry) => entry.name));
    for (const name of localNames) expect(spriteNames.has(name)).toBe(true);
    expect(spriteNames.size).toBeGreaterThan(localNames.size);
  });

  it("keeps the sprite profile a strict subset of the full profile in size", () => {
    // The sprite profile cannot be a strict subset of the full profile by name, because it
    // keeps the local endpoint stand-in names the full profile has no equivalent of. The
    // credential count it demands must still stay strictly below the full count, so a future
    // edit that grows sprite to full size, or beyond it, fails here.
    expect(credentialsFor("sprite").length).toBeLessThan(credentialsFor("full").length);
  });

  it("takes every fly-sprites credential of the sprite profile from the full list", () => {
    const fullFlyNames = credentialsFor("full")
      .filter((entry) => entry.dependency === "fly-sprites")
      .map((entry) => entry.name)
      .sort();
    const spriteFlyNames = credentialsFor("sprite")
      .filter((entry) => entry.dependency === "fly-sprites")
      .map((entry) => entry.name)
      .sort();
    expect(spriteFlyNames).toEqual(fullFlyNames);
  });

  it("resolves the sprite profile when the variable states it", () => {
    expect(resolveProfile({ FACTOREE_LIVE_PROFILE: "sprite" })).toBe("sprite");
  });

  it("marks the sprite banner as not SDD section 66 proof", () => {
    expect(PROFILE_BANNER.sprite).toContain("NOT SDD SECTION 66 PROOF");
  });
});
