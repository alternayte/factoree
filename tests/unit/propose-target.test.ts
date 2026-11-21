import { describe, expect, it } from "vitest";
import { matchReplyToCandidates, namedNonMembers, proposeTarget, proposeTargets, selectTargets } from "~/domain/routing/select-targets.js";
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
  membership: "accepted",
  membershipDecidedBy: null,
  membershipDecidedAt: null,
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

describe("proposeTargets (docs/specs/change-sets.md, DI-21.130)", () => {
  const ANTHOLOGY = repository("alternayte/anthology", ["Dashboard"]);

  it("takes every repository the issue names, in set order", () => {
    expect(proposeTargets([FIXTURE, DASH, ANTHOLOGY], "Add the endpoint to anthology and call it from c-dash.", null)).toEqual({
      fullNames: ["alternayte/anthology", "alternayte/c-dash"],
      reason: "the issue names anthology and c-dash",
    });
  });

  it("lets a named repository win over the Linear project, so the refiner adds the rest", () => {
    expect(proposeTargets([DASH, ANTHOLOGY], "Change the anthology API.", "Dashboard")?.fullNames).toEqual(["alternayte/anthology"]);
  });

  it("takes every repository that declares the Linear project when the issue names none", () => {
    expect(proposeTargets([DASH, ANTHOLOGY, FIXTURE], "Show the version.", "dashboard")).toEqual({
      fullNames: ["alternayte/anthology", "alternayte/c-dash"],
      reason: 'the issue is in the Linear project "dashboard", which alternayte/anthology and alternayte/c-dash declare',
    });
  });

  it("decides nothing when no rule matches", () => {
    expect(proposeTargets([DASH, FIXTURE], "Show the version.", "Billing")).toBeNull();
  });

  it("selects the sole member, and else the proposal with a notice", () => {
    expect(selectTargets([DASH], null)).toEqual({ kind: "selected", repositories: [DASH], reason: "sole member", notify: false });
    expect(selectTargets([DASH, FIXTURE], null)).toEqual({ kind: "ambiguous", candidates: [DASH, FIXTURE] });
    expect(selectTargets([FIXTURE, DASH, ANTHOLOGY], { fullNames: ["alternayte/c-dash", "alternayte/anthology"], reason: "r" })).toEqual({
      kind: "selected",
      repositories: [ANTHOLOGY, DASH],
      reason: "r",
      notify: true,
    });
  });

  it("reads every candidate a human reply names", () => {
    expect(matchReplyToCandidates("c-dash, and alternayte/anthology.", [DASH, ANTHOLOGY, FIXTURE])).toEqual([ANTHOLOGY, DASH]);
    expect(matchReplyToCandidates("c-dash", [DASH, repository("someone/c-dash")])).toEqual([]);
  });
});

// docs/specs/repository-membership.md. A claim no admin accepted is never a target, and an issue
// that names it is told so.
describe("repository membership in target selection", () => {
  const PENDING = { ...repository("alternayte/anthology"), membership: "pending" as const };

  it("selects the sole member and ignores a pending claim", () => {
    expect(selectTargets([DASH, PENDING], null)).toMatchObject({ kind: "selected", repositories: [DASH], reason: "sole member" });
  });

  it("names a pending repository the issue names, and no member", () => {
    expect(namedNonMembers([DASH, PENDING], "Fix the anthology header and the c-dash footer.").map((r) => r.fullName)).toEqual(["alternayte/anthology"]);
    expect(namedNonMembers([DASH, PENDING], "Fix the c-dash footer.")).toEqual([]);
  });
});

