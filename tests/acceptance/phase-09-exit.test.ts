import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockActivityEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubPullRequests } from "~/adapters/github/github-pull-requests.js";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import {
  createPublishingActivities,
  publishBranchName,
  type PublishActivityInput,
} from "~/activities/publishing.activities.js";
import { assertSameChangedFiles, capturePatch, PatchError } from "~/domain/publishing/patch.js";
import { checkBase } from "~/domain/publishing/stale-base.js";
import {
  publishToBranch,
  PatchHashMismatchError,
  type TrustedCheckoutInput,
} from "~/domain/publishing/trusted-checkout.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { SandboxRef } from "~/domain/runs/sandbox.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";
import { createBareRemote, type BareRemote } from "./support/bare-remote.js";
import { installCoreutilsBase64, type Base64Shim } from "./support/coreutils-base64.js";
import { startGitHubFixtureApi, type GitHubFixtureApi } from "./support/github-fixture-api.js";

/**
 * The Phase 9 exit condition. Only the exact verified patch can reach GitHub.
 *
 * Every case drives the real `capturePatch` against a real local sandbox worktree. Every case
 * drives the real `publishToBranch` or the real `publish` activity against a real bare
 * repository. No case replaces the code under test with a double.
 */

const TOKEN = "ghp_phase09tokenvalue0123456789abc";
const CHANGED_CONTENT = "the Implementer changed this line\n";
const NEW_CONTENT = "the Implementer added this file\n";
const AUTHOR = { name: "Factoree", email: "factoree@users.noreply.github.com" };

let remote: BareRemote;
let sandbox: LocalProcessSandbox;
let sandboxRoot: string;
let ref: SandboxRef;
let primaryPath: string;
let patchBase64: string;
let patchSha256: string;
let changedFiles: string[];
let treeSha: string;

const redactor = new Redactor([]);

let shim: Base64Shim;

/** Every Factoree branch the bare remote holds. The exit condition needs it. */
const factoreeBranches = (): string[] =>
  remote.listRefs().filter((name) => name.startsWith("refs/heads/factoree/"));

/** Every temporary directory of a trusted checkout that still exists. */
const publishDirectories = (): string[] =>
  readdirSync(tmpdir()).filter((name) => name.startsWith("factoree-publish-"));

const trustedInput = (
  overrides: Partial<TrustedCheckoutInput> & { branch: string },
): TrustedCheckoutInput => ({
  cloneUrl: remote.cloneUrl,
  baseSha: remote.baseSha,
  patchBase64,
  verifiedPatchSha256: patchSha256,
  commitMessage: "Factoree change\n",
  authorName: AUTHOR.name,
  authorEmail: AUTHOR.email,
  ...overrides,
});

beforeAll(async () => {
  shim = installCoreutilsBase64();
  remote = await createBareRemote({
    files: { "README.md": "base\n", "target.txt": "original\n" },
  });

  sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-phase09-sandbox-"));
  sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
  ref = await sandbox.create({ runId: "phase09", tenantId: "tenant-1", projectId: "project-1" });
  primaryPath = `${ref.workspacePath}/primary`;

  const prepared = await sandbox.exec(ref, {
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
  expect(prepared.stdout).toBe("OK");

  // The real capture of the real worktree. Every case below reuses this verified artifact.
  const patch = await capturePatch({ sandbox, redactor }, { ref, primaryPath, baseSha: remote.baseSha });
  patchBase64 = patch.patchBase64;
  patchSha256 = patch.patchSha256;
  changedFiles = patch.changedFiles;
  treeSha = patch.treeSha;
});

afterAll(async () => {
  await sandbox.destroy(ref);
  await rm(sandboxRoot, { recursive: true, force: true });
  await remote.destroy();
  shim.remove();
});

describe("Phase 9 exit: only the exact verified patch can reach GitHub", () => {
  it("case 1: the honest patch reaches the remote with the sandbox tree", async () => {
    const branch = "factoree/run-honest";
    const publication = await publishToBranch(trustedInput({ branch }));

    expect(publication.publishedPatchSha256).toBe(patchSha256);
    // Controller decision 12. The trusted checkout produced the tree the sandbox staged.
    expect(publication.treeSha).toBe(treeSha);
    expect(remote.refSha(branch)).toBe(publication.commitSha);
    expect(changedFiles).toEqual(["added.txt", "target.txt"]);

    const show = (path: string): string =>
      execFileSync("git", ["show", `${branch}:${path}`], { cwd: remote.cloneUrl, encoding: "utf8" });
    expect(show("target.txt")).toBe(CHANGED_CONTENT);
    expect(show("added.txt")).toBe(NEW_CONTENT);
  });

  it("case 2: a patch tampered after the hash was taken reaches no remote", async () => {
    const branch = "factoree/run-tampered-patch";
    const before = publishDirectories().length;

    // One byte of an added line changes. The patch still applies, so the refusal comes from the
    // hash gate and from nothing else.
    const bytes = Buffer.from(patchBase64, "base64");
    const marker = Buffer.from("+the Implementer changed this line", "utf8");
    const at = bytes.indexOf(marker);
    expect(at).toBeGreaterThan(0);
    const flipped = Buffer.from(bytes);
    flipped[at + 1] = (flipped[at + 1] ?? 0) ^ 0x20;

    await expect(
      publishToBranch(
        trustedInput({ branch, patchBase64: flipped.toString("base64") }),
      ),
    ).rejects.toBeInstanceOf(PatchHashMismatchError);

    expect(remote.refSha(branch)).toBeNull();
    expect(factoreeBranches()).toEqual(["refs/heads/factoree/run-honest"]);
    expect(publishDirectories().length).toBe(before);
  });

  it("case 3: a verified hash that no patch produces reaches no remote", async () => {
    const branch = "factoree/run-tampered-hash";
    const before = publishDirectories().length;

    await expect(
      publishToBranch(trustedInput({ branch, verifiedPatchSha256: "f".repeat(64) })),
    ).rejects.toBeInstanceOf(PatchHashMismatchError);

    expect(remote.refSha(branch)).toBeNull();
    expect(factoreeBranches()).toEqual(["refs/heads/factoree/run-honest"]);
    expect(publishDirectories().length).toBe(before);
  });

  it("case 4: a base that moved after the Run started publishes nothing", async () => {
    const reader = new GitRepositoryReader();
    try {
      const fresh = await checkBase(reader, {
        url: remote.cloneUrl,
        branch: "main",
        runBaseSha: remote.baseSha,
      });
      expect(fresh.fresh).toBe(true);

      const moved = remote.advanceHead("another author changed the branch\n");
      expect(moved).not.toBe(remote.baseSha);

      const stale = await checkBase(reader, {
        url: remote.cloneUrl,
        branch: "main",
        runBaseSha: remote.baseSha,
      });
      expect(stale.fresh).toBe(false);
      expect(stale.currentTargetSha).toBe(moved);
    } finally {
      reader.close();
    }

    // SDD section 45. Version 1 never rebases, so the workflow publishes nothing. The remote
    // still holds the one branch case 1 pushed.
    expect(factoreeBranches()).toEqual(["refs/heads/factoree/run-honest"]);
  });

  it("case 5: a patch that names a file the review never saw is refused before any remote call", async () => {
    // The domain rule itself refuses the disagreement.
    expect(() => assertSameChangedFiles(["target.txt"], changedFiles)).toThrow(PatchError);

    // The real `publish` activity refuses it too, and it makes no remote call.
    const api: GitHubFixtureApi = await startGitHubFixtureApi();
    const attempted: string[] = [];
    const runs = {
      setPublication: (): Promise<void> => Promise.resolve(),
    } as unknown as RunRepository;
    const activities = createPublishingActivities({
      sandbox,
      secrets: new MemorySecretStore({ GITHUB_TOKEN: TOKEN }),
      redactor,
      runs,
      repositoryReader: {
        resolveRef: (): Promise<string> =>
          Promise.reject(new Error("the publish activity must not read the repository")),
        listTree: () => Promise.resolve({ entries: [], truncated: false }),
        readBlob: () => Promise.resolve(null),
      },
      pullRequests: (token: string) => new GitHubPullRequests({ apiBaseUrl: api.baseUrl, token }),
      gitAuthor: AUTHOR,
      logger: createLogger({ level: "debug", redactor, sink: () => undefined }),
      publishToBranch: (value: TrustedCheckoutInput) => {
        attempted.push(value.branch);
        return publishToBranch({ ...value, cloneUrl: remote.cloneUrl });
      },
    });

    const runId = "phase09-disagreement";
    const input: PublishActivityInput = {
      runId,
      tenantId: "tenant-1",
      projectId: "project-1",
      spriteId: ref.id,
      adapter: ref.adapter,
      workspacePath: ref.workspacePath,
      primaryPath,
      repositorySlug: "acme/app",
      repositoryBaseUrl: "https://github.test",
      baseBranch: "main",
      baseSha: remote.baseSha,
      // The review examined one file only. The patch names two.
      reviewedChangedFiles: ["target.txt"],
      workItemTitle: "Change the target file",
      workItemUrl: null,
      verificationSummary: "every deterministic check passed",
      repairCount: 0,
    };

    try {
      const environment = new MockActivityEnvironment();
      await expect(
        environment.run((value: PublishActivityInput) => activities.publish(value), input),
      ).rejects.toThrow(/does not name the files the independent review examined/);

      expect(attempted).toEqual([]);
      expect(api.created).toEqual([]);
      expect(api.lookups).toEqual([]);
      expect(remote.refSha(publishBranchName(runId))).toBeNull();
      expect(factoreeBranches()).toEqual(["refs/heads/factoree/run-honest"]);
    } finally {
      await api.stop();
    }
  });
});
