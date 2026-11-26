import { describe, expect, it } from "vitest";
import { createSetupActivities, type SetupActivityDependencies } from "~/activities/setup.activities.js";
import type { RepositorySetupRecord, RepositorySetupStore } from "~/domain/setup/repository-setup.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { NewRunEvent } from "~/domain/diagnostics/run-event.js";
import type { HostCredential } from "~/domain/products/host-credentials.js";
import type { NugetPrecheckReport } from "~/domain/setup/nuget-precheck.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { installNugetWorld, mirrorCredential, PRIVATE_FEED_CONFIG, project, type NugetWorld } from "../support/fake-nuget.js";

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
  derivedHosts: null,
  warmProofMs: null,
  sandboxFault: null,
  createdAt: new Date(0),
  endedAt: null,
};

interface World {
  previous?: RepositorySetupRecord | null;
  latest?: RepositorySetupRecord | null;
  files?: Record<string, string>;
  /** The paths whose GitHub read fails. */
  unreadable?: string[];
  testSecrets?: string[];
  /** The session result over a finished session. */
  result?: { completed: boolean; outcome: string; summary: string };
  /** docs/specs/nuget-private-feed-mapping.md. The NuGet world the sandbox answers. */
  nuget?: NugetWorld;
  credentials?: HostCredential[];
}

const build = (status: string, world: World = {}) => {
  const previous = world.previous ?? null;
  const sandbox = new FakeSandbox();
  sandbox.onExec = (command) => {
    if (command.file === "git" && command.args.includes("status")) return { exitCode: 0, stdout: status, stderr: "" };
    if (command.file === "git" && command.args.includes("rev-parse")) return { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  if (world.nuget !== undefined) {
    const base = sandbox.onExec;
    installNugetWorld(sandbox, world.nuget, "/workspace/primary", (command) => base(command));
  }
  const credentials = world.credentials ?? [];
  const credentialHosts = credentials.flatMap((credential) => [credential.host, ...credential.redirectHosts]);
  const events: NewRunEvent[] = [];
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
    products: { findById: () => Promise.resolve({ id: "product-1", slug: "anthology", linearTeamKey: "FAC", allowedDomains: ["api.deepseek.com"], sandboxRetentionHours: 24, defaultRunner: "opencode", model: null, runners: { implementer: null, refiner: null, validator: null, reviewer: null, setup: null }, models: { implementer: null, refiner: null, validator: null, reviewer: null, setup: null }, effort: { implementer: null, refiner: null, validator: null, reviewer: null, setup: null } }) },
    sandbox,
    runners: {
      get: () => ({
        run: (input: { role: string; prompt: string }) => {
          runs.push(input.role);
          prompts.push(input.prompt);
          return Promise.resolve({ completed: true, summary: "", exitCode: 0, outcome: "finished", usage: null, model: null, effort: null, failureLog: null, session: { sessionId: "s", processId: "p" }, ...world.result });
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
      readFile: (_fullName: string, path: string) =>
        world.unreadable?.includes(path) === true ? Promise.reject(new Error(`HTTP 502 for ${path}`)) : Promise.resolve(world.files?.[path] ?? null),
    },
    hostCredentials: () =>
      Promise.resolve({
        credentials,
        hosts: credentialHosts,
        bindings: credentials.map((credential) => ({ name: credential.host, host: credential.host, header: "Authorization", value: "Basic c2VjcmV0", methods: ["GET", "HEAD"] })),
        refreshes: false,
      }),
    credentialHosts: () => Promise.resolve(credentialHosts),
    events: {
      store: {
        record: (event: NewRunEvent) => {
          events.push(event);
          return Promise.resolve();
        },
      },
      redactor: new Redactor(),
      logger: createLogger({ level: "error", redactor: new Redactor() }),
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
  const ready = async () => {
    const read = await activities.prepareSetup({ setupId: "setup-1", temporalRunId: "run-1" });
    return read.kind === "precheck" ? activities.precheckNugetFeeds({ setupId: "setup-1", prepared: read }) : read;
  };
  const session = async () => {
    const prepared = await ready();
    if (prepared.kind !== "run") throw new Error(`the setup did not run: ${prepared.kind}`);
    return activities.runSetupSession({ setupId: "setup-1", prepared });
  };
  return { activities, ready, session, sandbox, updates, runs, prompts, events };
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

  it("names the agent error when a failed session wrote no config (GitHub issue 37)", async () => {
    const { session, sandbox } = build("", {
      result: { completed: false, outcome: "failed", summary: "Anthropic API key is missing. Pass it using the 'apiKey' parameter." },
    });
    const exec = sandbox.onExec;
    sandbox.onExec = (command) =>
      command.file === "cat" && command.args[0]?.endsWith(".factoree/config.yaml") ? { exitCode: 1, stdout: "", stderr: "No such file" } : (exec?.(command) ?? { exitCode: 0, stdout: "", stderr: "" });
    expect(await session()).toEqual({
      kind: "failed",
      reason:
        "The setup agent wrote no .factoree/config.yaml. The agent session failed: Anthropic API key is missing. Pass it using the 'apiKey' parameter.",
    });
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

  it("fails the bootstrap that passes cold and fails after a warm restore (GitHub issue 59)", async () => {
    // FAC on E2B: `func bundles download` passed in the setup sandbox and failed in every run that
    // restored the warm snapshot, because the proof never ran the bootstrap a second time.
    const { activities, sandbox, updates } = build("");
    const scripts: string[] = [];
    let restored = false;
    const exec = sandbox.onExec;
    sandbox.onExec = (command) => {
      if (command.file === "sh" && (command.args.at(-1) ?? "").includes("func bundles download")) {
        scripts.push(command.args.at(-1) ?? "");
        return restored ? { exitCode: 1, stdout: "", stderr: "Cannot download extension bundles while in offline mode." } : { exitCode: 0, stdout: "", stderr: "" };
      }
      return exec?.(command) ?? { exitCode: 0, stdout: "", stderr: "" };
    };
    const removed: string[] = [];
    Object.defineProperty(sandbox, "warmSnapshots", {
      value: {
        template: "t",
        take: () => Promise.resolve("snap-1"),
        restore: () => {
          restored = true;
          return Promise.resolve({ id: "restored", adapter: "fake", workspacePath: "/workspace" });
        },
        remove: (id: string) => {
          removed.push(id);
          return Promise.resolve(true);
        },
      },
    });
    const proof = await activities.proveAndPublishSetup({
      setupId: "setup-1",
      session: {
        kind: "proposed",
        defaultBranch: "main",
        baseSha: "a".repeat(40),
        patchBase64: "",
        proposal:
          "version: 1\nidentity:\n  product: anthology\n  linear:\n    teamKey: FAC\nbootstrap:\n  command: func bundles download\nverify:\n  commands:\n    - name: build\n      run: dotnet build\n",
        observedHosts: [],
        deniedHosts: [],
        egressRecorded: true,
        appChanges: [],
        warm: false,
      },
    });
    expect(scripts).toHaveLength(2);
    // The proof runs the bootstrap as a run does: with pipefail where the shell has it.
    expect(scripts[0]).toContain("set -o pipefail");
    expect(proof.status).toBe("failed");
    expect(proof.failureMessage).toContain("The bootstrap failed after a warm restore");
    expect(removed).toEqual(["snap-1"]);
    expect(updates.some((update) => typeof update.warmProofMs === "number")).toBe(true);
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


describe("precheckNugetFeeds (docs/specs/nuget-private-feed-mapping.md)", () => {
  const repository = (references: Record<string, string>, config = PRIVATE_FEED_CONFIG): Record<string, string> => ({ "NuGet.config": config, "src/Api/Api.csproj": project(references) });
  const nugetWorld = (references: Record<string, string>, patch: Partial<NugetWorld> = {}, config = PRIVATE_FEED_CONFIG): World => ({
    files: { "NuGet.config": config },
    nuget: { files: repository(references, config), mirror: { "frontiers.core": ["3.1.0"] }, ...patch },
    credentials: [mirrorCredential()],
  });

  it("starts no pre-check for a repository whose feeds every sandbox reaches", async () => {
    const { activities } = build("", { files: { "NuGet.config": '<configuration><packageSources><add key="nuget.org" value="https://api.nuget.org/v3/index.json" /></packageSources></configuration>' } });
    expect((await activities.prepareSetup({ setupId: "setup-1", temporalRunId: "run-1" })).kind).toBe("run");
  });

  it("sends a setup whose NuGet config did not read to the pre-check, which reads the checkout", async () => {
    const world = { ...nugetWorld({ "Frontiers.Core": "3.1.0" }), unreadable: ["NuGet.config"] };
    const { activities, ready } = build("", world);
    expect((await activities.prepareSetup({ setupId: "setup-1", temporalRunId: "run-1" })).kind).toBe("precheck");
    const outcome = await ready();
    expect(outcome.kind === "run" ? outcome.nuget?.mirroredIds : outcome.kind).toEqual(["Frontiers.Core"]);
  });

  it("waits for the pre-check, before the key, when the repository names the private feed", async () => {
    const { activities, updates } = build("", nugetWorld({ "Frontiers.Core": "3.1.0" }));
    expect((await activities.prepareSetup({ setupId: "setup-1", temporalRunId: "run-1" })).kind).toBe("precheck");
    expect(updates.some((update) => update.inputKey !== undefined)).toBe(false);
  });

  it("gives the session the file it wrote, says so in the prompt, and writes it again after the session", async () => {
    const { session, sandbox, prompts, runs } = build("?? .factoree/config.yaml\0?? .factoree/nuget.config\0", nugetWorld({ "Frontiers.Core": "3.1.0" }));
    const written: string[] = [];
    const write = sandbox.writeFile.bind(sandbox);
    sandbox.writeFile = (ref, path, content) => {
      if (path.endsWith("/.factoree/nuget.config")) written.push(prompts.length === 0 ? "before" : "after");
      return write(ref, path, content);
    };
    const outcome = await session();
    expect(runs).toEqual(["setup"]);
    expect(prompts[0]).toContain("## Private NuGet feed");
    expect(prompts[0]).toContain("dotnet restore --configfile .factoree/nuget.config");
    expect(prompts[0]).toContain("Frontiers.Core");
    const config = sandbox.files.get("/workspace/primary/.factoree/nuget.config");
    expect(config).toContain('<package pattern="Frontiers.Core" />');
    // The pre-check writes it in its own sandbox, the session gets it, and Factoree writes it over any agent change.
    expect(written).toEqual(["before", "before", "after"]);
    expect(outcome.kind === "proposed" ? outcome.nuget?.outcome : outcome.kind).toBe("passed");
    expect(sandbox.destroyed.length).toBe(2);
  });

  it("fails the setup on a package the mirror lacks, with no session, a run event and the report", async () => {
    const { ready, runs, updates, events, sandbox } = build("", nugetWorld({ "Frontiers.Core": "3.1.0", "Frontiers.Missing": "2.0.0" }));
    const outcome = await ready();
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" ? outcome.reason : "").toContain("mirror these packages to https://github.com/orgs/frontiersin/packages");
    expect(runs).toEqual([]);
    expect(sandbox.destroyed.length).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "command_failed", stage: "setup", detail: { step: "setup_precheck:nuget" } });
    const stored = updates.find((update) => update.report !== undefined)!;
    expect(stored.inputKey).toBeTypeOf("string");
    expect(stored.report).toMatchObject({ appChanges: [], nuget: { outcome: "failed" } });
    expect(stored.report?.nuget?.packages.find((entry) => entry.id === "Frontiers.Missing")).toMatchObject({ status: "not_found", projects: ["src/Api/Api.csproj"] });
  });

  it("names the host of a missing credential", async () => {
    const { ready, runs } = build("", { ...nugetWorld({ "Frontiers.Core": "3.1.0" }), credentials: [] });
    const outcome = await ready();
    expect(outcome.kind === "failed" ? outcome.reason : "").toContain("add a host credential for nuget.pkg.github.com");
    expect(runs).toEqual([]);
  });

  it("fails an unsupported second private feed without a session", async () => {
    const config = PRIVATE_FEED_CONFIG.replace("</packageSources>", '  <add key="other" value="https://myget.example/F/x/api/v3/index.json" />\n  </packageSources>');
    const { ready, runs } = build("", nugetWorld({ "Frontiers.Core": "3.1.0" }, {}, config));
    const outcome = await ready();
    expect(outcome.kind === "failed" ? outcome.reason : "").toContain("unsupported private feed `myget.example`");
    expect(runs).toEqual([]);
  });

  it("passes a private feed no package uses, with no credential", async () => {
    const world = nugetWorld({ Serilog: "3.1.1" }, { nugetOrg: { serilog: { versions: ["3.1.1"] } } });
    const { ready } = build("", { ...world, credentials: [] });
    const outcome = await ready();
    expect(outcome.kind).toBe("run");
    expect(outcome.kind === "run" ? outcome.nuget?.credential : null).toBe("not_needed");
  });

  it("never skips a setup after a failed pre-check, and skips after a passed one with the same key", async () => {
    const failing = nugetWorld({ "Frontiers.Missing": "2.0.0" });
    const first = build("", failing);
    await first.ready();
    const failedKey = first.updates.find((update) => update.inputKey !== undefined)!.inputKey!;
    const again = build("", { ...failing, latest: { ...setupRow, id: "setup-0", status: "failed", endedAt: new Date(0), inputKey: failedKey } });
    expect((await again.ready()).kind).toBe("failed");
    expect(again.events).toHaveLength(1);

    const passing = nugetWorld({ "Frontiers.Core": "3.1.0" });
    const ran = build("", passing);
    await ran.ready();
    const passedKey = ran.updates.find((update) => update.inputKey !== undefined)!.inputKey!;
    const report = { parts: [], observedHosts: [], deniedHosts: [], egressRecorded: true, fakes: [], appChanges: [] };
    const skipped = build("", { ...passing, latest: { ...setupRow, id: "setup-0", status: "unchanged", endedAt: new Date(0), inputKey: passedKey, report } });
    expect((await skipped.ready()).kind).toBe("skipped");
    expect(skipped.runs).toEqual([]);
  });

  /** Each trusted git command from `-C <path>` on, in order. */
  const trustedGitCommands = (sandbox: FakeSandbox): string[] =>
    sandbox.commands.filter((command) => command.file === "/usr/bin/git").map((command) => command.args.slice(command.args.indexOf("-C") + 2).join(" "));

  it("stages the file it wrote even when the repository ignores it, and no other ignored path, before the session's patch capture", async () => {
    const { session, sandbox } = build("?? .factoree/config.yaml\0", nugetWorld({ "Frontiers.Core": "3.1.0" }));
    expect((await session()).kind).toBe("proposed");
    const commands = trustedGitCommands(sandbox);
    const forced = commands.indexOf("add --force -- .factoree/nuget.config");
    expect(forced).toBeGreaterThanOrEqual(0);
    expect(forced).toBeLessThan(commands.indexOf("add -A"));
    expect(commands.filter((command) => command.includes("--force"))).toHaveLength(1);
  });

  it("stages the file again before the proof's patch capture", async () => {
    const { activities, sandbox } = build("");
    const nuget: NugetPrecheckReport = {
      outcome: "passed",
      feeds: [],
      credential: "present",
      publicPackages: 0,
      packages: [],
      configPath: ".factoree/nuget.config",
      mirroredIds: ["Frontiers.Core"],
      restore: { outcome: "passed", rounds: 1, detail: null },
      failure: null,
    };
    await activities.proveAndPublishSetup({
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
        appChanges: [],
        warm: false,
        nuget,
      },
    });
    const commands = trustedGitCommands(sandbox);
    const forced = commands.indexOf("add --force -- .factoree/nuget.config");
    expect(forced).toBeGreaterThanOrEqual(0);
    expect(forced).toBeLessThan(commands.indexOf("add -A"));
  });

  it("changes the key when the mirror answer changes", async () => {
    const keyOf = async (world: World): Promise<string> => {
      const built = build("", world);
      await built.ready();
      return built.updates.find((update) => update.inputKey !== undefined)!.inputKey!;
    };
    const one = await keyOf(nugetWorld({ "Frontiers.Core": "3.1.0" }));
    const two = await keyOf(nugetWorld({ "Frontiers.Core": "3.1.0" }, { mirror: {} }));
    expect(one).not.toBe(two);
  });
});
