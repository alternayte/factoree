import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { checkoutRepositories } from "~/domain/runs/checkout.js";

const run = promisify(execFile);

/**
 * Creates a git repository on disk that a clone can reach through a file path. The repository
 * allows the file transport, because a newer git version refuses it by default.
 */
const createRepository = async (root: string, name: string, fileName: string): Promise<string> => {
  const path = join(root, name);
  await run("git", ["init", "--initial-branch=main", path]);
  await run("git", ["-C", path, "config", "protocol.file.allow", "always"]);
  await writeFile(join(path, fileName), "original\n", "utf8");
  await run("git", ["-C", path, "add", "."]);
  await run("git", ["-C", path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "initial"]);
  return path;
};

describe("checkoutRepositories against real git repositories", () => {
  let root: string;
  let sandboxRoot: string;
  let primaryUrl: string;
  let referenceUrl: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-repos-"));
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-sandbox-"));
    primaryUrl = await createRepository(root, "app", "index.txt");
    referenceUrl = await createRepository(root, "design", "notes.txt");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("captures the real base SHA, writes the primary worktree, and denies the reference worktree", async () => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const result = await checkoutRepositories(sandbox, ref, {
      primary: { url: primaryUrl, ref: "main" },
      references: [{ url: referenceUrl, ref: "main" }],
    });

    expect(result.primary.baseSha).toMatch(/^[0-9a-f]{40}$/);

    const writePrimary = await sandbox.exec(ref, {
      file: "sh",
      args: ["-c", `printf changed > ${result.primary.path}/index.txt && printf OK`],
    });
    expect(writePrimary.stdout).toBe("OK");

    const referencePath = result.references[0]?.path ?? "";
    const writeReference = await sandbox.exec(ref, {
      file: "sh",
      args: ["-c", `printf changed > ${referencePath}/notes.txt 2>/dev/null; printf %s $?`],
    });
    expect(writeReference.stdout).not.toBe("0");

    const push = await sandbox.exec(ref, {
      file: "sh",
      args: ["-c", `git -C ${result.primary.path} push origin HEAD 2>&1; printf "|%s" $?`],
    });
    expect(push.stdout).not.toContain("|0");
    // The push must fail because Factoree disabled the push URL, not for an unrelated reason.
    expect(push.stdout).toContain("DISABLED_BY_FACTOREE");

    // Restores write permission before cleanup, because the read-only control also blocks the
    // test harness from removing the directory.
    await sandbox.exec(ref, { file: "chmod", args: ["-R", "u+w", referencePath] });
    await sandbox.destroy(ref);
  });
});
