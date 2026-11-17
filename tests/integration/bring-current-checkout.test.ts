import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bringCurrentOnTrustedCheckout, PatchHashMismatchError } from "~/domain/publishing/trusted-checkout.js";
import { applyPatch, capturePatch } from "~/domain/publishing/patch.js";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { Redactor } from "~/telemetry/redaction.js";

let root: string;
let bare: string;
let work: string;
let headSha: string;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });

const commitOnMain = (files: Record<string, string>, message: string): string => {
  git(work, "checkout", "-q", "main");
  git(work, "pull", "-q", "origin", "main");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", message);
  git(work, "push", "-q", "origin", "main");
  return git(work, "rev-parse", "HEAD").trim();
};

const common = () => ({
  cloneUrl: bare,
  branch: "factoree/pr",
  headSha,
  baseBranch: "main",
  commitMessage: (baseSha: string) => `Merge main into factoree/pr\n\nBase SHA: ${baseSha}\n`,
  commitTimestamp: "1970-01-01T00:00:00Z",
  authorName: "Factoree",
  authorEmail: "factoree@example.test",
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "factoree-bring-current-"));
  bare = join(root, "remote.git");
  work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", bare]);
  execFileSync("git", ["clone", "-q", bare, work]);
  git(work, "config", "user.email", "fixture@example.test");
  git(work, "config", "user.name", "Fixture");
  writeFileSync(join(work, "a.txt"), "one\ntwo\nthree\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  git(work, "push", "-q", "origin", "main");
  // The pull request branch: one change to a.txt and one new file.
  git(work, "checkout", "-q", "-b", "factoree/pr");
  writeFileSync(join(work, "a.txt"), "ONE\ntwo\nthree\n");
  writeFileSync(join(work, "b.txt"), "b\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "change");
  git(work, "push", "-q", "origin", "factoree/pr");
  headSha = git(work, "rev-parse", "HEAD").trim();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.117. */
describe("bringCurrentOnTrustedCheckout", () => {
  it("answers current while the branch holds its base", async () => {
    expect((await bringCurrentOnTrustedCheckout(common())).kind).toBe("current");
  });

  it("merges a moved base, gives the patch the check sprite captures, and pushes only that merge", async () => {
    const baseSha = commitOnMain({ "c.txt": "c\n" }, "unrelated");
    const merged = await bringCurrentOnTrustedCheckout(common());
    if (merged.kind !== "merged") throw new Error(`expected a merge, got ${merged.kind}`);
    expect(merged.baseSha).toBe(baseSha);
    // The verified patch is the change of the pull request from the new base.
    expect(merged.changedFiles).toEqual(["a.txt", "b.txt"]);
    expect(merged.pushedFiles).toEqual(["c.txt"]);
    expect(merged.pushed).toBe(false);
    expect(git(bare, "rev-parse", "factoree/pr").trim()).toBe(headSha);

    // The check sprite applies the patch to the new base, and its own capture gives the same hash.
    const sandboxRoot = mkdtempSync(join(tmpdir(), "factoree-bring-current-sprite-"));
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const ref = await sandbox.create({ runId: "run-bring-current", tenantId: "tenant-1", productId: "product-1" });
    const primaryPath = `${ref.workspacePath}/primary`;
    try {
      execFileSync("git", ["clone", "-q", bare, primaryPath]);
      git(primaryPath, "checkout", "-q", "--detach", baseSha);
      const dependencies = { sandbox, redactor: new Redactor([]) };
      await applyPatch(dependencies, { ref, primaryPath, baseSha, patchBase64: merged.patchBase64 });
      const captured = await capturePatch(dependencies, { ref, primaryPath, baseSha });
      expect(captured.patchSha256).toBe(merged.patchSha256);
    } finally {
      await sandbox.destroy(ref);
      rmSync(sandboxRoot, { recursive: true, force: true });
    }

    // A patch other than the verified one pushes nothing.
    const refused = await bringCurrentOnTrustedCheckout({ ...common(), baseSha, pushVerifiedPatchSha256: "0".repeat(64) })
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(refused).toBeInstanceOf(PatchHashMismatchError);
    expect(git(bare, "rev-parse", "factoree/pr").trim()).toBe(headSha);

    // The verified merge is pushed with no force, as a merge commit of the head and the base.
    const pushed = await bringCurrentOnTrustedCheckout({ ...common(), baseSha, pushVerifiedPatchSha256: merged.patchSha256 });
    if (pushed.kind !== "merged") throw new Error(`expected a merge, got ${pushed.kind}`);
    expect(pushed.pushed).toBe(true);
    expect(git(bare, "rev-parse", "factoree/pr").trim()).toBe(pushed.commitSha);
    expect(git(bare, "rev-parse", `${pushed.commitSha}^1`, `${pushed.commitSha}^2`).trim().split("\n")).toEqual([headSha, baseSha]);

    // The branch moved, so the old head is no longer the head to merge into.
    expect((await bringCurrentOnTrustedCheckout(common())).kind).toBe("moved");
    headSha = pushed.commitSha;
  });

  it("names each conflicting file and pushes nothing", async () => {
    commitOnMain({ "a.txt": "uno\ntwo\nthree\n" }, "conflicting");
    const conflict = await bringCurrentOnTrustedCheckout(common());
    expect(conflict).toMatchObject({ kind: "conflict", conflicts: ["a.txt"] });
    expect(git(bare, "rev-parse", "factoree/pr").trim()).toBe(headSha);
  });
});
