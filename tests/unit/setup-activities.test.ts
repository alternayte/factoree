import { describe, expect, it } from "vitest";
import { createSetupActivities, type SetupActivityDependencies } from "~/activities/setup.activities.js";
import type { RepositorySetupRecord, RepositorySetupStore } from "~/domain/setup/repository-setup.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const setupRow: RepositorySetupRecord = {
  id: "setup-1",
  tenantId: "tenant-1",
  productId: "product-1",
  repositoryFullName: "acme/anthology",
  githubInstallationId: "42",
  workflowId: "repository-setup:tenant-1:acme/anthology",
  status: "queued",
  pullRequestUrl: null,
  report: null,
  failureMessage: null,
  sessionUsage: null,
  followUpSetupId: null,
  inputKey: null,
  skippedFromSetupId: null,
  temporalRunId: null,
  proofMs: null,
  warm: null,
  createdAt: new Date(0),
  endedAt: null,
};

interface World {
  previous?: RepositorySetupRecord | null;
  latest?: RepositorySetupRecord | null;
  files?: Record<string, string>;
  testSecrets?: string[];
}

const build = (status: string, world: World = {}) => {
  const previous = world.previous ?? null;
  const sandbox = new FakeSandbox();
  sandbox.onExec = (command) => {
    if (command.file === "git" && command.args.includes("status")) return { exitCode: 0, stdout: status, stderr: "" };
    if (command.file === "git" && command.args.includes("rev-parse")) return { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const updates: Array<Partial<RepositorySetupRecord>> = [];
  const setups: RepositorySetupStore = {
    create: () => Promise.reject(new Error("unused")),
    findById: () => Promise.resolve(setupRow),
    latestByProduct: () => Promise.resolve([]),
    previousWithReport: () => Promise.resolve(previous),
    latestOpenPullRequest: () => Promise.resolve(null),
    latestEnded: () => Promise.resolve(world.latest ?? null),
    listForRepository: () => Promise.resolve([]),
    update: (_id, patch) => {
      updates.push(patch);
      return Promise.resolve();
    },
  };
  const runs: string[] = [];
  const prompts: string[] = [];
  const dependencies = {
    setups,
    products: { findById: () => Promise.resolve({ id: "product-1", slug: "anthology", linearTeamKey: "FAC", allowedDomains: ["api.deepseek.com"], sandboxRetentionHours: 24 }) },
    sandbox,
    runners: {
      get: () => ({
        run: (input: { role: string; prompt: string }) => {
          runs.push(input.role);
          prompts.push(input.prompt);
          return Promise.resolve({ outcome: "finished", usage: null, model: null, effort: null, session: { sessionId: "s", processId: "p" } });
        },
      }),
    },
    secrets: {
      list: () => Promise.resolve((world.testSecrets ?? []).map((name) => ({ name, kind: "test", injectIntoImplementer: false }))),
      get: () => Promise.resolve(null),
      listNames: () => Promise.resolve([]),
    },
    tokens: { tokenForInstallation: () => Promise.resolve("ghs_token") },
    discoveryClient: { listInstallationRepositories: () => Promise.resolve([{ fullName: "acme/anthology", defaultBranch: "main" }]) },
    repositoryFiles: {
      headSha: () => Promise.resolve("b".repeat(40)),
      readFile: (_fullName: string, path: string) => Promise.resolve(world.files?.[path] ?? null),
    },
    browser: { name: "unused" },
    previewProbe: () => Promise.resolve(null),
    pullRequests: () => ({}),
    gitAuthor: () => Promise.resolve({ name: "Factoree", email: "f@example.test" }),
    repositoryBaseUrl: () => Promise.resolve("https://github.com"),
    redactor: new Redactor(),
    logger: createLogger({ level: "error", redactor: new Redactor() }),
  } as unknown as SetupActivityDependencies;
  const activities = createSetupActivities(dependencies);
  /** The workflow's order: the inputs and the key, then the session when the setup does not skip. */
  const session = async () => {
    const prepared = await activities.prepareSetup({ setupId: "setup-1", temporalRunId: "run-1" });
    if (prepared.kind !== "run") throw new Error(`the setup did not run: ${prepared.kind}`);
    return activities.runSetupSession({ setupId: "setup-1", prepared });
  };
  return { activities, session, sandbox, updates, runs, prompts };
};

describe("runSetupSession (repository-setup-and-services.md)", () => {
  it("runs the setup role and refuses a session that changed a file outside .factoree/", async () => {
    const { session, sandbox, updates, runs } = build("?? .factoree/config.yaml\0 M src/Program.cs\0");
    const outcome = await session();
    expect(runs).toEqual(["setup"]);
    expect(outcome).toEqual({
      kind: "failed",
      reason: "The setup agent changed files outside .factoree/, so Factoree refused the setup: src/Program.cs.",
    });
    expect(updates[0]).toEqual({ status: "running", temporalRunId: "run-1" });
    expect(sandbox.calls).toContain("destroy");
  });

  it("reaches only the repository, the ecosystem host list and the product allow list", async () => {
    const { session, sandbox } = build("");
    await session();
    const policy = sandbox.policies[0]!.allowedDomains;
    expect(policy).toContain("github.com");
    expect(policy).toContain("api.nuget.org");
    expect(policy).toContain("api.deepseek.com");
    expect(policy).not.toContain("example.org");
  });

  it("names the parts the previous setup could not prove (DI-21.18)", async () => {
    // anthology: a setup pull request holds only the proven parts, and the next agent kept that
    // config as it was. It never tried the test command or the account again.
    const previous: RepositorySetupRecord = {
      ...setupRow,
      id: "setup-0",
      report: {
        parts: [
          { kind: "bootstrap", name: "bootstrap", passed: true, reason: null },
          { kind: "verify", name: "test", passed: false, reason: "it exited with code 1" },
          { kind: "account", name: "member", passed: false, reason: "the sign-in failed at step 2" },
        ],
        observedHosts: [],
        deniedHosts: [],
        egressRecorded: true,
        fakes: [],
        appChanges: [],
      },
    };
    const { session, prompts } = build("", { previous });
    await session();
    expect(prompts[0]).toContain("- verify `test`: it exited with code 1\n- account `member`: the sign-in failed at step 2");
    expect(prompts[0]).not.toContain("bootstrap: null");
  });
});

describe("proveAndPublishSetup (DI-21.20)", () => {
  it("proves an empty patch against the default branch and ends unchanged, with no pull request", async () => {
    // anthology 2026-11-06: the agent kept the merged config, every gap needed an app change, and
    // git apply refused the empty patch, so the setup failed.
    const { activities, sandbox } = build("");
    const proof = await activities.proveAndPublishSetup({
      setupId: "setup-1",
      session: {
        kind: "proposed",
        defaultBranch: "main",
        baseSha: "a".repeat(40),
        patchBase64: "",
        proposal: "version: 1\nidentity:\n  product: anthology\n  linear:\n    teamKey: FAC\nverify:\n  commands:\n    - name: build\n      run: dotnet build\n",
        observedHosts: [],
        deniedHosts: [],
        egressRecorded: true,
        appChanges: ["src/Api/TmdbClient.cs hard-codes the TMDB base URL. Read it from TMDB__BaseUrl."],
        warm: false,
      },
    });
    expect(proof).toEqual({ status: "unchanged", pullRequestUrl: null, failureMessage: null });
    expect(sandbox.calls).toContain("destroy");
  });
});

describe("prepareSetup (docs/specs/setup-speed-and-history.md)", () => {
  const ended = (patch: Partial<RepositorySetupRecord>): RepositorySetupRecord => ({
    ...setupRow,
    id: "setup-0",
    status: "unchanged",
    endedAt: new Date(0),
    report: { parts: [], observedHosts: [], deniedHosts: [], egressRecorded: true, fakes: [], appChanges: [] },
    ...patch,
  });
  const keyOf = async (world: World): Promise<string> => {
    const { activities, updates } = build("", world);
    await activities.prepareSetup({ setupId: "setup-1", temporalRunId: "run-1" });
    return updates.find((update) => update.inputKey !== undefined)!.inputKey!;
  };

  it("skips the session when the newest ended setup is unchanged with the same key, and copies its report", async () => {
    const key = await keyOf({});
    const { activities, updates, runs, sandbox } = build("", { latest: ended({ inputKey: key }) });
    expect(await activities.prepareSetup({ setupId: "setup-1", temporalRunId: "run-1" })).toEqual({ kind: "skipped" });
    expect(updates.at(-1)).toMatchObject({ status: "unchanged", skippedFromSetupId: "setup-0" });
    expect(runs).toEqual([]);
    expect(sandbox.calls).not.toContain("create");
  });

  it("names the setup that ran when the matched setup was itself skipped", async () => {
    const key = await keyOf({});
    const { activities, updates } = build("", { latest: ended({ id: "setup-5", inputKey: key, skippedFromSetupId: "setup-0" }) });
    await activities.prepareSetup({ setupId: "setup-1", temporalRunId: "run-1" });
    expect(updates.at(-1)).toMatchObject({ skippedFromSetupId: "setup-0" });
  });

  it("runs after a failed setup with the same key, because a failure can be transient", async () => {
    const key = await keyOf({});
    const { activities } = build("", { latest: ended({ status: "failed", inputKey: key }) });
    expect((await activities.prepareSetup({ setupId: "setup-1", temporalRunId: "run-1" })).kind).toBe("run");
  });

  it("changes the key when a test secret, the config or the instructions change", async () => {
    const base = await keyOf({});
    expect(await keyOf({ testSecrets: ["TMDB_API_KEY"] })).not.toBe(base);
    expect(await keyOf({ files: { ".factoree/config.yaml": "version: 1\n" } })).not.toBe(base);
    expect(await keyOf({ files: { "CLAUDE.md": "Run just test." } })).not.toBe(base);
    expect(await keyOf({})).toBe(base);
  });

  it("puts the first repository instruction file in the prompt, under the setup rules", async () => {
    const { session, prompts } = build("", { files: { "CLAUDE.md": "Run `just test` for the tests.", "CONTRIBUTING.md": "Open an issue first." } });
    await session();
    expect(prompts[0]).toContain("## Repository instructions");
    expect(prompts[0]).toContain("The repository's CLAUDE.md follows.");
    expect(prompts[0]).toContain("Run `just test` for the tests.");
    expect(prompts[0]).not.toContain("Open an issue first.");
  });

  it("tells the agent on a configured repository to run only the parts it changes", async () => {
    const previous = ended({
      status: "merged",
      report: {
        parts: [
          { kind: "bootstrap", name: "bootstrap", passed: true, reason: null },
          { kind: "verify", name: "test", passed: true, reason: null },
        ],
        observedHosts: [],
        deniedHosts: [],
        egressRecorded: true,
        fakes: [],
        appChanges: [],
      },
    });
    const { session, prompts } = build("", { previous, files: { ".factoree/config.yaml": "version: 1\n" } });
    await session();
    expect(prompts[0]).toContain("Run yourself only the parts you add or change");
    expect(prompts[0]).toContain("The previous setup proved these parts:\n- bootstrap\n- verify `test`");
  });
});

