import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createPublishingActivities,
  publishBranchName,
  type PreflightChangeSetActivityInput,
  type PublishingActivityDependencies,
  type RollbackChangeSetActivityInput,
} from "~/activities/publishing.activities.js";
import type { PullRequestPort, PullRequestRecord } from "~/domain/publishing/pull-request.js";
import { changeSetSection, targetResultsSentence } from "~/domain/publishing/change-set.js";
import { setPatchSha256 } from "~/domain/publishing/patch.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { Command, CommandResult, Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";

const BASE = "a".repeat(40);
const TREE = "b".repeat(40);
const API = "/workspace/targets/acme/api";
const WEB = "/workspace/targets/acme/web";
const PATCHES: Record<string, { files: string[]; text: string }> = {
  [API]: { files: [".github/workflows/ci.yml", "src/api.ts"], text: "diff --git a/src/api.ts b/src/api.ts\n+api\n" },
  [WEB]: { files: ["src/web.ts"], text: "diff --git a/src/web.ts b/src/web.ts\n+web\n" },
};
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A sandbox that answers `capturePatch` for the checkout its last `-C` names. */
const setSandbox = (): Sandbox => {
  let path = API;
  const exec = (_ref: SandboxRef, command: Command): Promise<CommandResult> => {
    const at = command.args.indexOf("-C");
    if (at >= 0) path = command.args[at + 1] ?? path;
    const line = [command.file, ...command.args].join(" ");
    const patch = PATCHES[path] ?? { files: [], text: "" };
    let stdout = "";
    if (line.includes("--name-only")) stdout = patch.files.join("\n");
    else if (line.includes("write-tree")) stdout = `${TREE}\n`;
    else if (command.args.includes('base64 < "$0"')) stdout = Buffer.from(patch.text).toString("base64");
    return Promise.resolve({ exitCode: 0, stdout, stderr: "", timedOut: false, durationMs: 1 });
  };
  return { name: "stub", capabilities: { supportsDocker: false }, exec } as unknown as Sandbox;
};

const record = (slug: string, over: Partial<PullRequestRecord> = {}): PullRequestRecord => ({
  number: slug === "acme/api" ? 7 : 9,
  url: `https://github.com/${slug}/pull/${slug === "acme/api" ? "7" : "9"}`,
  headBranch: publishBranchName("run-1"),
  headSha: "c".repeat(40),
  state: "open",
  baseBranch: "main",
  ...over,
});

const build = (existing: Record<string, PullRequestRecord | null>) => {
  const calls: string[] = [];
  const scopes: Array<Record<string, string> | undefined> = [];
  const cleared: string[] = [];
  const port: PullRequestPort = {
    findByHead: (slug) => Promise.resolve(existing[slug] ?? null),
    create: () => Promise.reject(new Error("the preflight and the rollback open nothing")),
    body: () => Promise.resolve(null),
    updateBody: (slug, number) => {
      calls.push(`body ${slug}#${String(number)}`);
      return Promise.resolve();
    },
    comment: (slug, number, body) => {
      calls.push(`comment ${slug}#${String(number)}: ${body.split("\n")[0] ?? ""}`);
      return Promise.resolve();
    },
    close: (slug, number) => {
      calls.push(`close ${slug}#${String(number)}`);
      const current = existing[slug];
      if (current !== undefined && current !== null) existing[slug] = { ...current, state: "closed" };
      return Promise.resolve();
    },
    deleteBranch: (slug, branch) => {
      calls.push(`delete ${slug} ${branch}`);
      return Promise.resolve();
    },
  };
  const redactor = new Redactor([]);
  const dependencies: PublishingActivityDependencies = {
    sandbox: setSandbox(),
    secrets: new MemorySecretStore({}),
    tokens: {
      tokenForInstallation: (_id: string, scope?: Record<string, string>) => {
        scopes.push(scope);
        return Promise.resolve("ghs_token0123456789abcdef");
      },
    },
    redactor,
    runs: {
      clearPublication: (_tenant: string, _run: string, slug: string) => {
        cleared.push(slug);
        return Promise.resolve();
      },
    } as unknown as RunRepository,
    pullRequests: () => port,
    gitAuthor: () => Promise.resolve({ name: "Factoree", email: "factoree@example.com" }),
    logger: createLogger({ level: "error", redactor }),
  };
  return { activities: createPublishingActivities(dependencies), calls, scopes, cleared };
};

const target = (slug: string, path: string) => ({
  repositorySlug: slug,
  githubInstallationId: "install-1",
  primaryPath: path,
  baseBranch: "main",
  baseSha: BASE,
  verifiedPatchSha256: sha(PATCHES[path]?.text ?? ""),
  reviewedChangedFiles: PATCHES[path]?.files ?? [],
  reviewedWorktreeSha: TREE,
});

const preflightInput = (): PreflightChangeSetActivityInput => {
  const targets = [target("acme/api", API), target("acme/web", WEB)];
  return {
    runId: "run-1",
    tenantId: "tenant-1",
    productId: "product-1",
    spriteId: "sprite-1",
    adapter: "stub",
    workspacePath: "/workspace",
    repositoryBaseUrl: "https://github.com",
    targets,
    verifiedSetPatchSha256: setPatchSha256(targets.map((entry) => ({ repository: entry.repositorySlug, patchSha256: entry.verifiedPatchSha256 }))),
    reviewedSetTreeSha: setPatchSha256(targets.map((entry) => ({ repository: entry.repositorySlug, patchSha256: TREE }))),
  };
};

describe("the preflight of a change set (docs/specs/change-sets.md, DI-21.151)", () => {
  it("mints Workflows only for the target whose patch changes a workflow, and pushes nothing", async () => {
    const { activities, scopes, calls } = build({});
    const output = await activities.preflightChangeSet(preflightInput());
    expect(output.targets.map((entry) => [entry.repositorySlug, entry.changed])).toEqual([["acme/api", true], ["acme/web", true]]);
    expect(scopes).toEqual([
      { contents: "write", pull_requests: "write", workflows: "write" },
      { contents: "write", pull_requests: "write" },
    ]);
    expect(calls).toEqual([]);
  });

  it("refuses a foreign pull request on the branch of a later target, and names that target", async () => {
    const { activities } = build({ "acme/web": record("acme/web", { state: "closed" }) });
    await expect(
      activities.preflightChangeSet(preflightInput()),
    ).rejects.toMatchObject({ message: expect.stringContaining("acme/web: the branch factoree/run-run-1 already holds") as unknown });
  });

  it("refuses a set whose trees differ from the trees the review examined", async () => {
    const { activities } = build({});
    await expect(
      activities.preflightChangeSet({ ...preflightInput(), reviewedSetTreeSha: "f".repeat(64) }),
    ).rejects.toMatchObject({ message: expect.stringContaining("trees of the change set changed") as unknown });
  });
});

describe("the rollback of a change set (DI-21.153)", () => {
  const rollback: RollbackChangeSetActivityInput = {
    runId: "run-1",
    tenantId: "tenant-1",
    productId: "product-1",
    targets: [
      { repositorySlug: "acme/api", githubInstallationId: "install-1" },
      { repositorySlug: "acme/web", githubInstallationId: "install-1" },
    ],
    failedRepository: "acme/web",
    cause: "GitHub refused the push.",
  };

  it("closes the open pull request of the run's branch with a comment that names the failed target, and deletes each branch", async () => {
    const existing: Record<string, PullRequestRecord | null> = { "acme/api": record("acme/api"), "acme/web": null };
    const { activities, calls, cleared } = build(existing);
    const output = await activities.rollbackChangeSet(rollback);
    expect(output.closed).toEqual([{ repository: "acme/api", url: "https://github.com/acme/api/pull/7" }]);
    expect(calls).toEqual([
      "comment acme/api#7: Factoree closed this pull request because the publication of acme/web, another repository of the same change set, failed: GitHub refused the push.",
      "close acme/api#7",
      "delete acme/api factoree/run-run-1",
      "delete acme/web factoree/run-run-1",
    ]);
    expect(cleared).toEqual(["acme/api"]);

    // A retry finds the pull request closed: it comments and closes nothing again.
    calls.length = 0;
    await activities.rollbackChangeSet(rollback);
    expect(calls).toEqual(["delete acme/api factoree/run-run-1", "delete acme/web factoree/run-run-1"]);
  });

  it("closes no pull request of another branch", async () => {
    const { activities, calls } = build({ "acme/api": record("acme/api", { headBranch: "feature/other" }) });
    const output = await activities.rollbackChangeSet(rollback);
    expect(output.closed).toEqual([]);
    expect(calls.filter((call) => !call.startsWith("delete"))).toEqual([]);
  });
});

describe("the change set section of a pull request body (DI-21.152)", () => {
  const pullRequests = [
    { repository: "acme/api", url: "https://github.com/acme/api/pull/7" },
    { repository: "acme/web", url: "https://github.com/acme/web/pull/9" },
  ];

  it("links every sibling and states the merge order of the cited edges", () => {
    const section = changeSetSection("acme/web", pullRequests, [{ provider: "acme/api", consumer: "acme/web" }]);
    expect(section).toContain("- acme/api: https://github.com/acme/api/pull/7");
    expect(section).not.toContain("- acme/web: https://github.com/acme/web/pull/9");
    expect(section).toContain("1. acme/api: https://github.com/acme/api/pull/7");
    expect(section).toContain("2. acme/web: https://github.com/acme/web/pull/9");
  });

  it("states that no safe order exists for a cycle", () => {
    const section = changeSetSection("acme/api", pullRequests, [
      { provider: "acme/api", consumer: "acme/web" },
      { provider: "acme/web", consumer: "acme/api" },
    ]);
    expect(section.join("\n")).toContain("No safe merge order exists");
  });
});

describe("the result of each target of a failed change set (DI-21.154)", () => {
  it("names the failed checks and assertions of each target", () => {
    expect(
      targetResultsSentence(["acme/api", "acme/web"], {
        verification: [
          { name: "acme/api: test", passed: true },
          { name: "acme/web: test", passed: false },
        ],
      }),
    ).toBe("Each target: acme/api passed; acme/web: `acme/web: test` failed.");
    expect(
      targetResultsSentence(["acme/api", "acme/web"], {
        validation: [{ assertionId: "VAL-1", result: "FAIL", target: "acme/web" }],
        inBetweenFailed: ["acme/web"],
      }),
    ).toBe("Each target: acme/api passed; acme/web: VAL-1 is FAIL, the in-between check failed.");
    expect(targetResultsSentence(["acme/api"], {})).toBe("");
  });
});
