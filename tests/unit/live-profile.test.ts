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
});
