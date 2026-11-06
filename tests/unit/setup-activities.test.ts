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
  createdAt: new Date(0),
  endedAt: null,
};

const build = (status: string, previous: RepositorySetupRecord | null = null) => {
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
    secrets: { list: () => Promise.resolve([]), get: () => Promise.resolve(null), listNames: () => Promise.resolve([]) },
    tokens: { tokenForInstallation: () => Promise.resolve("ghs_token") },
    discoveryClient: { listInstallationRepositories: () => Promise.resolve([{ fullName: "acme/anthology", defaultBranch: "main" }]) },
    browser: { name: "unused" },
    previewProbe: () => Promise.resolve(null),
    pullRequests: () => ({}),
    gitAuthor: () => Promise.resolve({ name: "Factoree", email: "f@example.test" }),
    repositoryBaseUrl: () => Promise.resolve("https://github.com"),
    redactor: new Redactor(),
    logger: createLogger({ level: "error", redactor: new Redactor() }),
  } as unknown as SetupActivityDependencies;
  return { activities: createSetupActivities(dependencies), sandbox, updates, runs, prompts };
};

describe("runSetupSession (repository-setup-and-services.md)", () => {
  it("runs the setup role and refuses a session that changed a file outside .factoree/", async () => {
    const { activities, sandbox, updates, runs } = build("?? .factoree/config.yaml\0 M src/Program.cs\0");
    const outcome = await activities.runSetupSession({ setupId: "setup-1" });
    expect(runs).toEqual(["setup"]);
    expect(outcome).toEqual({
      kind: "failed",
      reason: "The setup agent changed files outside .factoree/, so Factoree refused the setup: src/Program.cs.",
    });
    expect(updates[0]).toEqual({ status: "running" });
    expect(sandbox.calls).toContain("destroy");
  });

  it("reaches only the repository, the ecosystem host list and the product allow list", async () => {
    const { activities, sandbox } = build("");
    await activities.runSetupSession({ setupId: "setup-1" });
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
    const { activities, prompts } = build("", previous);
    await activities.runSetupSession({ setupId: "setup-1" });
    expect(prompts[0]).toContain("- verify `test`: it exited with code 1\n- account `member`: the sign-in failed at step 2");
    expect(prompts[0]).not.toContain("bootstrap: null");
  });
});
