import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { DEFAULT_PROJECT_DEFAULTS } from "~/domain/runs/project-runtime-config.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import type { ContextFixture } from "./support/context-fixture-repository.js";
import { buildContextFixture } from "./support/context-fixture-repository.js";
import { commitAll } from "./support/fixture-repository.js";

let fixture: ContextFixture;
let sandboxRoot: string;
const reader = new GitRepositoryReader();

beforeAll(async () => {
  fixture = await buildContextFixture();
  sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-at05-sandboxes-"));
});

afterAll(async () => {
  reader.close();
  fixture.cleanup();
  // A reference checkout is read-only, so the directory tree must become writable again before
  // the test can remove it.
  execFileSync("chmod", ["-R", "u+w", sandboxRoot]);
  await rm(sandboxRoot, { recursive: true, force: true });
});

/**
 * AT-05. A discovered reference repository is checked out at an explicit commit SHA and is
 * read-only to the Implementer.
 *
 * Known limitation, carried forward from the Phase 2 record. The read-only control is a file
 * mode, and the user that owns the directory can reverse it. The real control is to run the
 * agent as a user that does not own the reference checkout. This test proves the file mode and
 * the explicit SHA. It does not prove that a determined agent cannot restore write access.
 */
describe("AT-05 — a reference repository is pinned and read-only", () => {
  it("checks the reference out at the discovered SHA and denies a write to it", async () => {
    // SDD section 20. Discovery pins an explicit commit SHA before any checkout starts.
    const referenceSha = await reader.resolveRef(fixture.referenceUrl, "main");
    expect(referenceSha).toMatch(/^[0-9a-f]{40}$/);
    expect(referenceSha).toBe(fixture.referenceSha);

    // The branch moves after discovery pinned the SHA. A checkout that follows the branch
    // instead of the pinned SHA now lands on a different commit, so the assertion below can
    // fail.
    await writeFile(join(fixture.referencePath, "LATER.md"), "# Later\n", "utf8");
    const movedSha = await commitAll(fixture.referencePath, "a later commit");
    expect(movedSha).not.toBe(referenceSha);

    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const prepared = await manager.prepare({
      runId: "run-at-05",
      tenantId: "tenant-1",
      projectId: "project-1",
      primary: { url: fixture.primaryUrl, ref: "main" },
      references: [{ url: fixture.referenceUrl, ref: referenceSha }],
      defaults: DEFAULT_PROJECT_DEFAULTS,
    });

    // SDD section 20. The checkout landed on that exact SHA, not on a moving ref.
    const reference = prepared.checkout.references[0];
    expect(reference?.baseSha).toBe(referenceSha);
    expect(reference?.readOnly).toBe(true);

    // SDD section 29. The Implementer must not write a reference repository.
    const write = await sandbox.exec(prepared.ref, {
      file: "sh",
      args: ["-c", `echo changed > ${reference?.path ?? ""}/README.md`],
    });
    expect(write.exitCode).not.toBe(0);

    // The primary worktree stays writable, so the control is specific to the reference checkout
    // and is not a blanket failure of every write.
    const primaryWrite = await sandbox.exec(prepared.ref, {
      file: "sh",
      args: ["-c", `echo changed > ${prepared.checkout.primary.path}/scratch.txt`],
    });
    expect(primaryWrite.exitCode).toBe(0);

    await manager.release(prepared);
  });
});
