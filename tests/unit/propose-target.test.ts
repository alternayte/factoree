import { describe, expect, it } from "vitest";
import { proposeTarget } from "~/domain/routing/select-targets.js";
import type { RepositoryRecord } from "~/domain/products/repository-registry.js";

const repository = (fullName: string, linearProjects: string[] = []): RepositoryRecord => ({
  id: fullName,
  tenantId: "tenant-1",
  productId: "product-1",
  fullName,
  defaultBranch: "main",
  configSha: "aaa",
  requestedSecretNames: [],
  linearProjects,
  discoveredAt: new Date(0),
  lastSeenAt: new Date(0),
  absentSince: null,
  githubInstallationId: "install-1",
});

const DASH = repository("alternayte/c-dash", ["Dashboard"]);
const FIXTURE = repository("alternayte/factoree-live-fixture");

describe("proposeTarget (docs/specs/own-proposals-and-parallel-runs.md)", () => {
  it("chooses the one repository the issue names by its short name", () => {
    expect(proposeTarget([DASH, FIXTURE], "Show the app version in the c-dash footer.", null)).toEqual({
      fullName: "alternayte/c-dash",
      reason: "the issue names c-dash",
      confident: true,
    });
  });

  it("chooses the one repository the issue names by its full name, at the end of a sentence", () => {
    expect(proposeTarget([DASH, FIXTURE], "Fix the footer in alternayte/c-dash.", null)?.fullName).toBe("alternayte/c-dash");
  });

  it("does not read a longer name as a mention", () => {
    expect(proposeTarget([DASH, FIXTURE], "Change c-dash-api and c-dash.io.", null)).toBeNull();
  });

  it("decides nothing when the issue names two repositories", () => {
    expect(proposeTarget([DASH, FIXTURE], "Touch c-dash and factoree-live-fixture.", null)).toBeNull();
  });

  it("ignores a short name that two repositories share, and still accepts the full name", () => {
    const fork = repository("someone/c-dash");
    expect(proposeTarget([DASH, fork], "Change c-dash.", null)).toBeNull();
    expect(proposeTarget([DASH, fork], "Change someone/c-dash.", null)?.fullName).toBe("someone/c-dash");
  });

  it("chooses the one repository that declares the issue's Linear project", () => {
    expect(proposeTarget([DASH, FIXTURE], "Show the version.", "dashboard")).toEqual({
      fullName: "alternayte/c-dash",
      reason: 'the issue is in the Linear project "dashboard", which alternayte/c-dash declares',
      confident: true,
    });
  });

  it("decides nothing when no rule matches, so the human chooses", () => {
    expect(proposeTarget([DASH, FIXTURE], "Show the version.", "Billing")).toBeNull();
    expect(proposeTarget([DASH, FIXTURE], "Show the version.", null)).toBeNull();
  });
});
