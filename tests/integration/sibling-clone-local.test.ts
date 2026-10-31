import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { buildSiblingCloner, SiblingCloneDeniedError } from "~/domain/runs/sibling-clone.js";
import { FakeEvidenceStore } from "../support/fake-evidence-store.js";

const run = promisify(execFile);

/**
 * Creates a git repository on disk that a clone can reach through a file path. The repository
 * allows the file transport, because a newer git version refuses it by default. The path
 * segment ends in `.git`, so `buildRepositoryUrl` resolves the `owner/repo` full name to it.
 */
const createRepository = async (root: string, relativePath: string, fileName: string): Promise<string> => {
  const path = join(root, `${relativePath}.git`);
  await mkdir(path, { recursive: true });
  await run("git", ["init", "--initial-branch=main", path]);
  await run("git", ["-C", path, "config", "protocol.file.allow", "always"]);
  await writeFile(join(path, fileName), "original\n", "utf8");
  await run("git", ["-C", path, "add", "."]);
  await run("git", ["-C", path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "initial"]);
  return path;
};

describe("buildSiblingCloner against a real git repository", () => {
  let root: string;
  let sandboxRoot: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-sibling-repos-"));
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-sibling-sandbox-"));
    await createRepository(root, "acme/web", "notes.txt");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("clones a member repository read-only, and a real write attempt fails on disk", async () => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    const evidence = new FakeEvidenceStore();
    const cloner = buildSiblingCloner({
      sandbox,
      ref,
      evidence,
      tenantId: "t",
      repositories: [{ id: "1", fullName: "acme/web", defaultBranch: "main", absentSince: null, githubInstallationId: "install-1", linearProjects: [] }],
      repositoryBaseUrl: root,
    });

    const result = await cloner.cloneSibling({ fullName: "acme/web", runId: "run-1", role: "implementer" });
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.path).toBe(`${ref.workspacePath}/siblings/acme/web`);

    const write = await sandbox.exec(ref, {
      file: "sh",
      args: ["-c", `printf changed > ${result.path}/notes.txt 2>/dev/null; printf %s $?`],
    });
    expect(write.stdout).not.toBe("0");

    expect(evidence.rows).toHaveLength(1);
    const row = evidence.rows[0];
    expect(row?.kind).toBe("sibling_read");
    expect(row?.metadata).toEqual({ fullName: "acme/web", commitSha: result.commitSha, role: "implementer" });

    await sandbox.exec(ref, { file: "chmod", args: ["-R", "u+w", result.path] });
    await sandbox.destroy(ref);
  });

  it("denies a clone of a repository the Product does not own", async () => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const ref = await sandbox.create({ runId: "r2", tenantId: "t", productId: "p" });
    const evidence = new FakeEvidenceStore();
    const cloner = buildSiblingCloner({
      sandbox,
      ref,
      evidence,
      tenantId: "t",
      repositories: [{ id: "1", fullName: "acme/api", defaultBranch: "main", absentSince: null, githubInstallationId: "install-1", linearProjects: [] }],
      repositoryBaseUrl: "https://example.invalid",
    });

    await expect(
      cloner.cloneSibling({ fullName: "acme/other", runId: "run-2", role: "implementer" }),
    ).rejects.toThrow(SiblingCloneDeniedError);
    expect(evidence.rows).toHaveLength(0);
    await sandbox.destroy(ref);
  });
});
