import { describe, expect, it } from "vitest";
import { createAppChangeActivities } from "~/activities/app-change.activities.js";
import type { AppChangeIssueMode, AppChangeIssueRecord, AppChangeIssueRun, AppChangeIssueStore } from "~/domain/setup/app-change-issues.js";
import type { RepositorySetupRecord, RepositorySetupStore } from "~/domain/setup/repository-setup.js";
import type { SetupReport } from "~/domain/setup/setup-report.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";

const report = (appChanges: string[]): SetupReport => ({ parts: [], observedHosts: [], deniedHosts: [], egressRecorded: true, fakes: [], appChanges });

const setupOf = (patch: Partial<RepositorySetupRecord>): RepositorySetupRecord => ({
  id: "setup-1",
  tenantId: "tenant-1",
  productId: "product-1",
  repositoryFullName: "acme/anthology",
  githubInstallationId: "42",
  workflowId: "repository-setup:tenant-1:acme/anthology",
  status: "proposed",
  pullRequestUrl: "https://github.com/acme/anthology/pull/11",
  report: report(["Read the TMDB base URL from TMDB__BaseUrl.", "Read the IGDB base URL from IGDB__BaseUrl."]),
  failureMessage: null,
  sessionUsage: null,
  followUpSetupId: null,
  createdAt: new Date(0),
  endedAt: new Date(0),
  ...patch,
});

/** An in-memory install: setups, stored issues, runs by Linear issue, and pull request states. */
const build = (input: { setups: RepositorySetupRecord[]; mode?: AppChangeIssueMode; stored?: AppChangeIssueRecord[] }) => {
  const setups = new Map(input.setups.map((setup) => [setup.id, { ...setup }]));
  const stored: AppChangeIssueRecord[] = [...(input.stored ?? [])];
  const runs = new Map<string, AppChangeIssueRun>();
  const states = new Map<string, "open" | "merged" | "closed">();
  const created: Array<{ title: string; description: string }> = [];
  const setupStore: RepositorySetupStore = {
    create: (row) => {
      const record = setupOf({ ...row, id: `setup-${setups.size + 1}`, status: "queued", pullRequestUrl: null, report: null });
      setups.set(record.id, record);
      return Promise.resolve(record);
    },
    findById: (id) => Promise.resolve(setups.get(id) ?? null),
    latestByProduct: () => Promise.resolve([]),
    previousWithReport: (_productId, _repository, before) =>
      Promise.resolve([...setups.values()].filter((setup) => setup.report !== null && setup.createdAt < before).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null),
    latestOpenPullRequest: () =>
      Promise.resolve([...setups.values()].reverse().find((setup) => (setup.status === "proposed" || setup.status === "partial") && setup.pullRequestUrl !== null) ?? null),
    update: (id, patch) => {
      setups.set(id, { ...setups.get(id)!, ...patch });
      return Promise.resolve();
    },
  };
  const issueStore: AppChangeIssueStore = {
    create: (row) => {
      const record: AppChangeIssueRecord = { ...row, id: `row-${stored.length + 1}`, outcome: null, createdAt: new Date(0), endedAt: null };
      stored.push(record);
      return Promise.resolve(record);
    },
    listForRepository: () => Promise.resolve(stored.map((row) => ({ ...row }))),
    setOutcome: (id, outcome) => {
      stored.find((row) => row.id === id)!.outcome = outcome;
      return Promise.resolve();
    },
    latestRun: (_tenantId, linearIssueId) => Promise.resolve(runs.get(linearIssueId) ?? null),
  };
  const activities = createAppChangeActivities({
    setups: setupStore,
    appChangeIssues: issueStore,
    products: { findById: () => Promise.resolve({ linearTeamId: "team-1", appChangeIssues: input.mode ?? "one_per_change" } as never) },
    linearIssues: () =>
      Promise.resolve({
        createDelegatedIssue: (issue) => {
          created.push(issue);
          return Promise.resolve({ id: `issue-${created.length}`, identifier: `FAC-${100 + created.length}` });
        },
      }),
    pullRequestState: (slug, number) => Promise.resolve(states.get(`${slug}#${number}`) ?? "open"),
    logger: createLogger({ level: "error", redactor: new Redactor() }),
  });
  return { activities, setups, stored, runs, states, created };
};

const push = { tenantId: "tenant-1", repositoryFullName: "acme/anthology" };

describe("afterSetupPush (docs/specs/setup-app-change-issues.md)", () => {
  it("does nothing while the setup pull request is open", async () => {
    const world = build({ setups: [setupOf({})] });
    expect(await world.activities.afterSetupPush(push)).toEqual({ followUps: [] });
    expect(world.created).toEqual([]);
    expect(world.setups.get("setup-1")!.status).toBe("proposed");
  });

  it("creates one delegated issue per app change when the setup merges, naming the repository", async () => {
    const world = build({ setups: [setupOf({})] });
    world.states.set("acme/anthology#11", "merged");
    await world.activities.afterSetupPush(push);
    expect(world.setups.get("setup-1")!.status).toBe("merged");
    expect(world.created.map((issue) => issue.title)).toEqual(["Read the TMDB base URL from TMDB__BaseUrl.", "Read the IGDB base URL from IGDB__BaseUrl."]);
    expect(world.created[0]!.description).toContain("Repository: acme/anthology");
    expect(world.created[0]!.description).toContain("https://github.com/acme/anthology/pull/11");
    expect(world.stored.map((row) => row.linearIssueIdentifier)).toEqual(["FAC-101", "FAC-102"]);
  });

  it("creates one issue for every change when the product says one for all", async () => {
    const world = build({ setups: [setupOf({})], mode: "one_for_all" });
    world.states.set("acme/anthology#11", "merged");
    await world.activities.afterSetupPush(push);
    expect(world.created).toHaveLength(1);
    expect(world.stored[0]!.changes).toHaveLength(2);
  });

  it("skips a change that an open issue already requests", async () => {
    const open: AppChangeIssueRecord = {
      id: "row-0",
      tenantId: "tenant-1",
      productId: "product-1",
      setupId: "setup-0",
      repositoryFullName: "acme/anthology",
      changes: ["read the tmdb base URL  from TMDB__BaseUrl."],
      linearIssueId: "issue-0",
      linearIssueIdentifier: "FAC-90",
      outcome: null,
      createdAt: new Date(0),
      endedAt: null,
    };
    const world = build({ setups: [setupOf({})], stored: [open] });
    world.states.set("acme/anthology#11", "merged");
    await world.activities.afterSetupPush(push);
    expect(world.created.map((issue) => issue.title)).toEqual(["Read the IGDB base URL from IGDB__BaseUrl."]);
  });

  it("starts one follow-up setup when every issue of the round ended and one merged", async () => {
    const world = build({ setups: [setupOf({})] });
    world.states.set("acme/anthology#11", "merged");
    await world.activities.afterSetupPush(push);

    // One issue's run merged its pull request. The other's run ended with none.
    world.runs.set("issue-1", { terminal: true, pullRequestUrl: "https://github.com/acme/anthology/pull/12" });
    world.runs.set("issue-2", { terminal: false, pullRequestUrl: null });
    world.states.set("acme/anthology#12", "merged");
    expect((await world.activities.afterSetupPush(push)).followUps).toEqual([]);

    world.runs.set("issue-2", { terminal: true, pullRequestUrl: null });
    const { followUps } = await world.activities.afterSetupPush(push);
    expect(followUps).toEqual([{ setupId: "setup-2", workflowId: "repository-setup:tenant-1:acme/anthology" }]);
    expect(world.setups.get("setup-1")!.followUpSetupId).toBe("setup-2");
    expect(world.stored.map((row) => row.outcome)).toEqual(["merged", "not_merged"]);

    // A later push finds the round already followed up.
    expect((await world.activities.afterSetupPush(push)).followUps).toEqual([]);
  });

  it("starts no follow-up setup when no app-change pull request merged", async () => {
    const world = build({ setups: [setupOf({})] });
    world.states.set("acme/anthology#11", "merged");
    await world.activities.afterSetupPush(push);
    world.runs.set("issue-1", { terminal: true, pullRequestUrl: null });
    world.runs.set("issue-2", { terminal: true, pullRequestUrl: "https://github.com/acme/anthology/pull/13" });
    world.states.set("acme/anthology#13", "closed");
    expect((await world.activities.afterSetupPush(push)).followUps).toEqual([]);
    expect(world.stored.map((row) => row.outcome)).toEqual(["not_merged", "not_merged"]);
  });

  it("creates no issues for a merged setup that a newer setup report supersedes (DI-21.20)", async () => {
    const newer = setupOf({ id: "setup-2", status: "unchanged", pullRequestUrl: null, createdAt: new Date(1000), report: report(["Read the TMDB base URL from Tmdb:BaseUrl."]) });
    const world = build({ setups: [setupOf({}), newer] });
    world.states.set("acme/anthology#11", "merged");
    await world.activities.afterSetupPush(push);
    expect(world.setups.get("setup-1")!.status).toBe("merged");
    expect(world.created).toEqual([]);
  });
});

describe("createSetupAppChangeIssues (DI-21.20)", () => {
  it("creates the issues of a setup that ended unchanged, with no pull request to merge", async () => {
    const world = build({ setups: [setupOf({ status: "unchanged", pullRequestUrl: null })] });
    await world.activities.createSetupAppChangeIssues({ setupId: "setup-1" });
    expect(world.created).toHaveLength(2);
    expect(world.created[0]!.description).toContain("Repository: acme/anthology");
    await world.activities.createSetupAppChangeIssues({ setupId: "setup-1" });
    expect(world.created).toHaveLength(2);
  });
});
