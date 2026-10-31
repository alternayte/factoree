import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockActivityEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubPullRequests } from "~/adapters/github/github-pull-requests.js";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import {
  createPublishingActivities,
  publishBranchName,
  type PublishActivityInput,
  type PublishActivityOutput,
} from "~/activities/publishing.activities.js";
import {
  publishToBranch as realPublishToBranch,
  type TrustedCheckoutInput,
} from "~/domain/publishing/trusted-checkout.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { SandboxRef } from "~/domain/runs/sandbox.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { capturePatch } from "~/domain/publishing/patch.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";
import { createBareRemote, type BareRemote } from "./support/bare-remote.js";
import { startGitHubFixtureApi, type GitHubFixtureApi } from "./support/github-fixture-api.js";

const TOKEN = "ghp_at29tokenvalue0123456789abcdef";
const RUN_ID = "at29-run";
const SLUG = "acme/app";
const CHANGED_CONTENT = "changed by the Implementer\n";
const NEW_CONTENT = "a file the Implementer added\n";
const VERIFICATION_SUMMARY = "every deterministic check passed on attempt 1";

/**
 * The `publish` activity refuses a clone URL that is not `https:`, because a remote helper URL
 * reaches command execution on the control plane. The acceptance remote is a local bare
 * repository, so this seam swaps only the URL and then calls the real trusted checkout. Every
 * gate of `publishToBranch` still runs.
 */
const localCloneUrl = (remote: BareRemote) => {
  const received: string[] = [];
  const tokens: (string | undefined)[] = [];
  const seam = (input: TrustedCheckoutInput) => {
    received.push(input.cloneUrl);
    tokens.push(input.token);
    return realPublishToBranch({ ...input, cloneUrl: remote.cloneUrl });
  };
  seam.received = received;
  seam.tokens = tokens;
  return seam;
};


interface PublicationRow {
  patchSha256: string;
  commitSha: string;
  pullRequestUrl: string;
}

const memoryRuns = (): RunRepository & { publications: PublicationRow[] } => {
  const publications: PublicationRow[] = [];
  return {
    publications,
    setPublication: (_tenantId: string, _runId: string, row: PublicationRow): Promise<void> => {
      publications.push(row);
      return Promise.resolve();
    },
  } as unknown as RunRepository & { publications: PublicationRow[] };
};

const readBlob = (remote: BareRemote, ref: string, path: string): string =>
  execFileSync("git", ["show", `${ref}:${path}`], { cwd: remote.cloneUrl, encoding: "utf8" });

let remote: BareRemote;
let api: GitHubFixtureApi;
let sandbox: LocalProcessSandbox;
let sandboxRoot: string;
let ref: SandboxRef;
let primaryPath: string;
let seam: ReturnType<typeof localCloneUrl>;
let runs: ReturnType<typeof memoryRuns>;
let input: PublishActivityInput;
let first: PublishActivityOutput;
let second: PublishActivityOutput;
let branch: string;
let logLines: string[];

const environment = new MockActivityEnvironment();

beforeAll(async () => {
  remote = await createBareRemote({
    files: { "README.md": "base\n", "target.txt": "original\n" },
  });
  api = await startGitHubFixtureApi({ resolveHeadSha: (name) => remote.refSha(name) });

  // A real sandbox worktree. The Implementer change lives in it, and the real `capturePatch`
  // reads it.
  sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-at29-sandbox-"));
  sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
  ref = await sandbox.create({ runId: RUN_ID, tenantId: "tenant-1", productId: "project-1" });
  primaryPath = `${ref.workspacePath}/primary`;
  const clone = await sandbox.exec(ref, {
    file: "sh",
    args: [
      "-c",
      `git clone "$1" "$2" >/dev/null 2>&1 && ` +
        `printf '%s' "$3" > "$2/target.txt" && printf '%s' "$4" > "$2/added.txt" && printf OK`,
      "sh",
      remote.cloneUrl,
      primaryPath,
      CHANGED_CONTENT,
      NEW_CONTENT,
    ],
  });
  expect(clone.stdout).toBe("OK");

  const redactor = new Redactor([]);
  logLines = [];
  seam = localCloneUrl(remote);
  runs = memoryRuns();
  const activities = createPublishingActivities({
    sandbox,
    secrets: new MemorySecretStore({}),
    tokens: { tokenForInstallation: () => Promise.resolve(TOKEN) },
    redactor,
    runs,
    pullRequests: (token: string) => new GitHubPullRequests({ apiBaseUrl: api.baseUrl, tokens: { tokenForInstallation: () => Promise.resolve(token) } }),
    gitAuthor: { name: "Factoree", email: "factoree@users.noreply.github.com" },
    logger: createLogger({ level: "debug", redactor, sink: (line) => logLines.push(line) }),
    publishToBranch: seam,
  });

  // The tree the independent review examined. The publication refuses a tree that differs, so
  // this fixture must stage the worktree and read the same value.
  const staged = await sandbox.exec(ref, {
    file: "sh",
    args: ["-c", 'git -C "$1" add -A && git -C "$1" write-tree', "sh", primaryPath],
  });
  expect(staged.exitCode).toBe(0);
  const stagedTreeSha = staged.stdout.trim();
  // The patch the check sprite received. Publication must capture exactly this patch.
  const verified = await capturePatch({ sandbox, redactor }, { ref, primaryPath, baseSha: remote.baseSha });

  branch = publishBranchName(RUN_ID);
  input = {
    runId: RUN_ID,
    tenantId: "tenant-1",
    productId: "project-1",
    spriteId: ref.id,
    adapter: ref.adapter,
    workspacePath: ref.workspacePath,
    primaryPath,
    repositorySlug: SLUG,
    repositoryBaseUrl: "https://github.test",
    baseBranch: "main",
    baseSha: remote.baseSha,
    reviewedChangedFiles: ["added.txt", "target.txt"],
    reviewedWorktreeSha: stagedTreeSha,
    verifiedPatchSha256: verified.patchSha256,
    draft: false,
    workItemTitle: "Rename the target file content",
    workItemUrl: "https://linear.app/acme/issue/ENG-29",
    verificationSummary: VERIFICATION_SUMMARY,
    repairCount: 1,
    githubInstallationId: "install-1",
  };

  first = await environment.run(
    (value: PublishActivityInput) => activities.publish(value),
    input,
  );
  // The AT-35 case. The same input runs a second time against the same fixture API.
  second = await environment.run(
    (value: PublishActivityInput) => activities.publish(value),
    input,
  );
});

afterAll(async () => {
  await api.stop();
  await sandbox.destroy(ref);
  await rm(sandboxRoot, { recursive: true, force: true });
  await remote.destroy();
});

describe("AT-29: the publication opens exactly one evidence-bearing pull request", () => {
  it("creates exactly one pull request", async () => {
    expect(api.created.length).toBe(1);
    const response = await fetch(
      `${api.baseUrl}/repos/${SLUG}/pulls?head=acme:${branch}&state=all`,
    );
    const listed = (await response.json()) as unknown[];
    expect(listed.length).toBe(1);
    expect(first.created).toBe(true);
    expect(first.pullRequestNumber).toBe(1);
  });

  it("names the Work Item, the Run, the base SHA, the patch hash, and the verification summary", () => {
    const body = api.created[0]?.body ?? "";
    expect(body).toContain(input.workItemTitle);
    expect(body).toContain("https://linear.app/acme/issue/ENG-29");
    expect(body).toContain(RUN_ID);
    expect(body).toContain(remote.baseSha);
    expect(body).toContain(first.patchSha256);
    expect(body).toContain(VERIFICATION_SUMMARY);
  });

  it("opens the deterministic Factoree branch against the Project default branch", () => {
    expect(first.branch).toBe(`factoree/run-${RUN_ID}`);
    expect(api.created[0]?.headBranch).toBe(`factoree/run-${RUN_ID}`);
    expect(api.created[0]?.baseBranch).toBe("main");
    expect(api.created[0]?.slug).toBe(SLUG);
    // The activity passed the PLAIN `https:` URL and never a local path of its own. SDD
    // section 30 forbids the credential on the process argument list, so the credential travels
    // out of band instead.
    expect(seam.received[0] ?? "").toBe("https://github.test/acme/app.git");
    expect(seam.received[0] ?? "").not.toContain(TOKEN);
    expect(seam.received[0] ?? "").not.toContain("x-access-token");
    expect(seam.tokens[0]).toBe(TOKEN);
  });

  it("creates no second pull request when the same input runs again (AT-35)", () => {
    expect(second.created).toBe(false);
    expect(second.pullRequestNumber).toBe(first.pullRequestNumber);
    expect(second.pullRequestUrl).toBe(first.pullRequestUrl);
    expect(api.created.length).toBe(1);
    // The second call took the existing pull request, so it ran no second trusted checkout.
    expect(seam.received.length).toBe(1);
  });

  it("publishes exactly the file content the sandbox worktree held", async () => {
    expect(remote.refSha(branch)).toBe(first.commitSha);
    expect(readBlob(remote, branch, "target.txt")).toBe(CHANGED_CONTENT);
    expect(readBlob(remote, branch, "added.txt")).toBe(NEW_CONTENT);
    expect(readBlob(remote, branch, "README.md")).toBe("base\n");

    const sandboxTarget = await sandbox.exec(ref, {
      file: "sh",
      args: ["-c", `cat "$1/target.txt"`, "sh", primaryPath],
    });
    expect(sandboxTarget.stdout).toBe(CHANGED_CONTENT);
    expect(runs.publications[0]?.commitSha).toBe(first.commitSha);
  });

  it("keeps the GitHub write credential out of every log line (SDD section 60)", () => {
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.some((line) => line.includes(TOKEN))).toBe(false);
  });

  it("refuses a repository base URL whose scheme is not https and reaches no remote", async () => {
    // A `git clone` of an `ext::` URL runs a command on the control plane. The scheme gate of
    // the publish activity is the only defence, so a hostile scheme must stop the whole Run.
    const hostileApi = await startGitHubFixtureApi();
    const attempted: string[] = [];
    const redactor = new Redactor([]);
    const runId = "at29-hostile-scheme";
    const activities = createPublishingActivities({
      sandbox,
      secrets: new MemorySecretStore({}),
      tokens: { tokenForInstallation: () => Promise.resolve(TOKEN) },
      redactor,
      runs: memoryRuns(),
      pullRequests: (token: string) =>
        new GitHubPullRequests({ apiBaseUrl: hostileApi.baseUrl, tokens: { tokenForInstallation: () => Promise.resolve(token) } }),
      gitAuthor: { name: "Factoree", email: "factoree@users.noreply.github.com" },
      logger: createLogger({ level: "debug", redactor, sink: () => undefined }),
      publishToBranch: (value: TrustedCheckoutInput) => {
        attempted.push(value.cloneUrl);
        return realPublishToBranch({ ...value, cloneUrl: remote.cloneUrl });
      },
    });

    try {
      await expect(
        environment.run(
          (value: PublishActivityInput) => activities.publish(value),
          { ...input, runId, repositoryBaseUrl: "ext::sh -c touch% /tmp/pwned" },
        ),
      ).rejects.toBeInstanceOf(RunConfigurationError);

      expect(attempted).toEqual([]);
      expect(hostileApi.created).toEqual([]);
      expect(hostileApi.lookups).toEqual([]);
      expect(remote.refSha(publishBranchName(runId))).toBeNull();
    } finally {
      await hostileApi.stop();
    }
  });
});
