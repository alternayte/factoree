import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  publishToBranch,
  PatchHashMismatchError,
  TrustedCheckoutError,
} from "~/domain/publishing/trusted-checkout.js";
import { PATCH_DIFF_ARGS, PATCH_GIT_OPTIONS, sha256OfBase64 } from "~/domain/publishing/patch.js";

let root: string;
let bare: string;
let work: string;
let baseSha: string;
let patchBase64: string;

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
      commitMessage: "Factoree change\n",
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
        commitMessage: "Factoree change\n",
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
        commitMessage: "Factoree change\n",
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
      commitMessage: "Factoree change\n",
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
        commitMessage: "Factoree change\n",
        authorName: "Factoree",
        authorEmail: "factoree@example.test",
      }),
    ).rejects.toBeInstanceOf(PatchHashMismatchError);

    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("factoree-publish-"));
    expect(after.length).toBe(before.length);
  });
});
