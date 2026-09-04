import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { OpenCodeRunner } from "~/adapters/runners/opencode/opencode-runner.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { DEFAULT_PROJECT_DEFAULTS } from "~/domain/runs/project-runtime-config.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createFixtureRepository } from "./support/fixture-repository.js";

const stub = resolve("tests/fixtures/bin/opencode-stub.sh");

describe("AT-12 — isolation", () => {
  let root: string;
  let sandboxRoot: string;
  let repository: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-at12-repos-"));
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-at12-sandboxes-"));
    repository = await createFixtureRepository(root, "app");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("three concurrent Runs use three different sandbox identifiers and cannot modify one another", async () => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const runner = new OpenCodeRunner({ executable: stub, redactor: new Redactor(), pollIntervalMs: 20 });

    const runIds = ["run-a", "run-b", "run-c"];
    const prepared = await Promise.all(
      runIds.map((runId) =>
        manager.prepare({
          runId,
          tenantId: "tenant-1",
          productId: "project-1",
          primary: { url: repository, ref: "main" },
          references: [],
          defaults: DEFAULT_PROJECT_DEFAULTS,
        }),
      ),
    );

    // Each Run holds its own sandbox identifier. That value becomes `Run.spriteId`.
    const identifiers = new Set(prepared.map((entry) => entry.ref.id));
    expect(identifiers.size).toBe(3);

    // Each sandbox also holds its own workspace, so no two Runs share one worktree.
    const workspaces = new Set(prepared.map((entry) => entry.ref.workspacePath));
    expect(workspaces.size).toBe(3);
    const worktrees = new Set(prepared.map((entry) => entry.checkout.primary.path));
    expect(worktrees.size).toBe(3);

    await Promise.all(
      prepared.map((entry, index) =>
        runner.run({
          runId: runIds[index] ?? "",
          tenantId: "tenant-1",
          role: "implementer",
          sandbox,
          ref: entry.ref,
          workingDirectory: entry.checkout.primary.path,
          prompt: `written by ${runIds[index] ?? ""}`,
          promptVersion: "implementer/1",
          environment: { FACTOREE_STUB_TARGET: "target.txt" },
          actionPolicy: buildActionPolicy(),
          timeoutMs: 20_000,
        }),
      ),
    );

    // Every Run must see only its own change. A Run that reached another Run's worktree leaves
    // the wrong text behind here.
    for (const [index, entry] of prepared.entries()) {
      const content = await readFile(join(entry.checkout.primary.path, "target.txt"), "utf8");
      expect(content.trim()).toBe(`written by ${runIds[index] ?? ""}`);
    }

    // The shared origin repository never receives any of the three changes.
    const origin = await readFile(join(repository, "target.txt"), "utf8");
    expect(origin.trim()).toBe("original");

    await Promise.all(prepared.map((entry) => manager.release(entry)));
  });
});
