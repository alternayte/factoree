import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  credentialEnvironment,
  isDeterministicCheckoutFailure,
  publishToBranch,
  PatchHashMismatchError,
  TrustedCheckoutError,
} from "~/domain/publishing/trusted-checkout.js";
import { PATCH_DIFF_ARGS, PATCH_GIT_OPTIONS, capturePatch, sha256OfBase64 } from "~/domain/publishing/patch.js";
import { captureSourceDiff } from "~/domain/review/source-diff.js";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { Redactor } from "~/telemetry/redaction.js";

let root: string;
let bare: string;
let work: string;
let baseSha: string;
let patchBase64: string;

/** The fixed commit date every case uses. It makes the commit object deterministic. */
const COMMIT_TIMESTAMP = "1970-01-01T00:00:00Z";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "factoree-trusted-"));
  bare = join(root, "remote.git");
  work = join(root, "work");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare]);
  execFileSync("git", ["clone", bare, work]);
  git(work, "config", "user.email", "fixture@example.test");
  git(work, "config", "user.name", "Fixture");
  writeFileSync(join(work, "README.md"), "base\n");
  git(work, "add", "-A");
  git(work, "commit", "-m", "base");
  git(work, "push", "origin", "main");
  baseSha = git(work, "rev-parse", "HEAD").trim();

  // The change under publication, captured exactly as the sandbox captures it.
  writeFileSync(join(work, "README.md"), "base\nchanged\n");
  writeFileSync(join(work, "new.txt"), "new file\n");
  git(work, "add", "-A");
  const patch = execFileSync("git", [...PATCH_GIT_OPTIONS, ...PATCH_DIFF_ARGS, baseSha], {
    cwd: work,
    encoding: "buffer",
  });
  patchBase64 = Buffer.from(patch).toString("base64");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("publishToBranch", () => {
  it("applies the patch, proves the hash again, and pushes one branch (AT-27)", async () => {
    const result = await publishToBranch({
      cloneUrl: bare,
      baseSha,
      branch: "factoree/run-1",
      patchBase64,
      verifiedPatchSha256: sha256OfBase64(patchBase64),
      verifiedGitVersion: "git version 0.0.0-test",
      commitMessage: "Factoree change\n",
      commitTimestamp: COMMIT_TIMESTAMP,
      authorName: "Factoree",
      authorEmail: "factoree@example.test",
    });

    expect(result.publishedPatchSha256).toBe(sha256OfBase64(patchBase64));
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const remoteHead = execFileSync("git", ["rev-parse", "factoree/run-1"], { cwd: bare, encoding: "utf8" }).trim();
    expect(remoteHead).toBe(result.commitSha);
  });

  it("refuses to publish when the patch does not reproduce the verified hash (AT-27)", async () => {
    await expect(
      publishToBranch({
        cloneUrl: bare,
        baseSha,
        branch: "factoree/run-2",
        patchBase64,
        verifiedPatchSha256: "f".repeat(64),
        verifiedGitVersion: "git version 0.0.0-test",
        commitMessage: "Factoree change\n",
        commitTimestamp: COMMIT_TIMESTAMP,
        authorName: "Factoree",
        authorEmail: "factoree@example.test",
      }),
    ).rejects.toBeInstanceOf(PatchHashMismatchError);

    // Nothing reached the remote.
    expect(() => execFileSync("git", ["rev-parse", "factoree/run-2"], { cwd: bare })).toThrow();
  });

  it("refuses a clone URL that starts with a hyphen and never runs a clone", async () => {
    await expect(
      publishToBranch({
        cloneUrl: "--upload-pack=false",
        baseSha,
        branch: "factoree/run-injection",
        patchBase64,
        verifiedPatchSha256: sha256OfBase64(patchBase64),
        verifiedGitVersion: "git version 0.0.0-test",
        commitMessage: "Factoree change\n",
        commitTimestamp: COMMIT_TIMESTAMP,
        authorName: "Factoree",
        authorEmail: "factoree@example.test",
      }),
    ).rejects.toBeInstanceOf(TrustedCheckoutError);

    // Nothing reached the remote, so the branch this attempt names does not exist.
    expect(() =>
      execFileSync("git", ["rev-parse", "factoree/run-injection"], { cwd: bare }),
    ).toThrow();
  });

  it("removes its temporary directory after a successful publish (SDD section 46 step 10)", async () => {
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("factoree-publish-"));
    const result = await publishToBranch({
      cloneUrl: bare,
      baseSha,
      branch: "factoree/run-3",
      patchBase64,
      verifiedPatchSha256: sha256OfBase64(patchBase64),
      verifiedGitVersion: "git version 0.0.0-test",
      commitMessage: "Factoree change\n",
      commitTimestamp: COMMIT_TIMESTAMP,
      authorName: "Factoree",
      authorEmail: "factoree@example.test",
    });

    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("factoree-publish-"));
    expect(after.length).toBe(before.length);
  });

  it("removes its temporary directory after a refused publish (SDD section 46 step 10)", async () => {
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("factoree-publish-"));
    await expect(
      publishToBranch({
        cloneUrl: bare,
        baseSha,
        branch: "factoree/run-4",
        patchBase64,
        verifiedPatchSha256: "f".repeat(64),
        verifiedGitVersion: "git version 0.0.0-test",
        commitMessage: "Factoree change\n",
        commitTimestamp: COMMIT_TIMESTAMP,
        authorName: "Factoree",
        authorEmail: "factoree@example.test",
      }),
    ).rejects.toBeInstanceOf(PatchHashMismatchError);

    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("factoree-publish-"));
    expect(after.length).toBe(before.length);
  });

  it("produces the identical commit SHA on a repeated call, so a retry pushes a no-op (AT-35)", async () => {
    const branch = "factoree/run-retry";
    const identical = {
      cloneUrl: bare,
      baseSha,
      branch,
      patchBase64,
      verifiedPatchSha256: sha256OfBase64(patchBase64),
      verifiedGitVersion: "git version 0.0.0-test",
      commitMessage: "Factoree change\n",
      commitTimestamp: COMMIT_TIMESTAMP,
      authorName: "Factoree",
      authorEmail: "factoree@example.test",
    };

    const first = await publishToBranch(identical);
    // The second call is the retry after a failed pull request creation. It must not fail.
    const second = await publishToBranch(identical);

    expect(second.commitSha).toBe(first.commitSha);
    const remoteHead = execFileSync("git", ["rev-parse", branch], {
      cwd: bare,
      encoding: "utf8",
    }).trim();
    expect(remoteHead).toBe(first.commitSha);

    // The same SHA alone is a weak claim, because both calls land in the same second. The
    // recorded dates state the claim properly. A wall clock value that returns to the commit
    // path fails these two assertions at once.
    const authorDate = execFileSync("git", ["log", "-1", "--format=%aI", branch], {
      cwd: bare,
      encoding: "utf8",
    }).trim();
    const committerDate = execFileSync("git", ["log", "-1", "--format=%cI", branch], {
      cwd: bare,
      encoding: "utf8",
    }).trim();
    expect(authorDate).toBe(COMMIT_TIMESTAMP);
    expect(committerDate).toBe(COMMIT_TIMESTAMP);
  });

  it("keeps the credential out of the process argument list and marks a deterministic failure", async () => {
    // SDD section 30. `ps` and `/proc/<pid>/cmdline` are world readable, so the credential
    // travels through the git environment instead of an argv element.
    const environment = credentialEnvironment("https://github.test/acme/app.git", "ghp_secret0value");
    expect(environment.GIT_CONFIG_COUNT).toBe("1");
    expect(environment.GIT_CONFIG_KEY_0).toBe("http.https://github.test/.extraheader");
    expect(environment.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${Buffer.from("x-access-token:ghp_secret0value", "utf8").toString("base64")}`,
    );
    // A local path remote needs no header.
    expect(credentialEnvironment(bare, "ghp_secret0value")).toEqual({});

    // SDD section 49. A base SHA the clone does not hold repeats on every attempt.
    const error = await publishToBranch({
      cloneUrl: bare,
      baseSha: "0".repeat(40),
      branch: "factoree/run-missing-base",
      patchBase64,
      verifiedPatchSha256: sha256OfBase64(patchBase64),
      verifiedGitVersion: "git version 0.0.0-test",
      commitMessage: "Factoree change\n",
      commitTimestamp: COMMIT_TIMESTAMP,
      authorName: "Factoree",
      authorEmail: "factoree@example.test",
    })
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TrustedCheckoutError);
    expect((error as TrustedCheckoutError).deterministic).toBe(true);

    // A timeout carries no deterministic phrase, so it stays retryable.
    expect(isDeterministicCheckoutFailure("Command failed: git clone, the read timed out")).toBe(false);
    expect(isDeterministicCheckoutFailure("fatal: Authentication failed for the remote")).toBe(true);
    expect(isDeterministicCheckoutFailure("error: patch failed: README.md:1")).toBe(true);
    expect(isDeterministicCheckoutFailure("fatal: unable to read tree (0000)")).toBe(true);
  });
});

describe("the review name query and the publication name query", () => {
  it("name the same files for a rename", async () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "factoree-rename-"));
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const ref = await sandbox.create({
      runId: "run-rename",
      tenantId: "tenant-1",
      projectId: "project-1",
    });
    const primaryPath = `${ref.workspacePath}/primary`;
    try {
      execFileSync("git", ["clone", bare, primaryPath]);
      // The Implementer moves one file. Git detects a rename, so an unpinned name query names
      // the destination path alone.
      execFileSync("git", ["mv", "README.md", "MOVED.md"], { cwd: primaryPath });

      const redactor = new Redactor([]);
      const review = await captureSourceDiff({ sandbox, redactor }, { ref, primaryPath, baseSha });
      const patch = await capturePatch({ sandbox, redactor }, { ref, primaryPath, baseSha });

      expect([...review.changedFiles].sort()).toEqual(["MOVED.md", "README.md"]);
      expect([...review.changedFiles].sort()).toEqual([...patch.changedFiles].sort());
    } finally {
      await sandbox.destroy(ref);
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });
});
