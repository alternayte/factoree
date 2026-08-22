import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { runSandboxContract } from "../support/sandbox-contract.js";

runSandboxContract("LocalProcessSandbox", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "factoree-contract-"));
  const sandbox = new LocalProcessSandbox({ rootDirectory });
  return { sandbox, dispose: async () => rm(rootDirectory, { recursive: true, force: true }) };
});

describe("LocalProcessSandbox", () => {
  it("declares that it cannot enforce a network policy", () => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: tmpdir() });
    expect(sandbox.capabilities.enforcesNetworkPolicy).toBe(false);
    expect(sandbox.name).toBe("local");
  });

  it("removes the workspace directory on destroy", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "factoree-destroy-"));
    const sandbox = new LocalProcessSandbox({ rootDirectory });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await sandbox.exec(ref, { file: "sh", args: ["-c", "printf x > marker"] });
    await sandbox.destroy(ref);
    await expect(sandbox.exec(ref, { file: "sh", args: ["-c", "true"] })).rejects.toThrow(/destroyed/);
    await rm(rootDirectory, { recursive: true, force: true });
  });

  it("removes a workspace that holds a read-only subtree", async () => {
    // Every reference checkout is read-only, because SDD section 29 denies an agent writing one.
    // A read-only directory blocks removal of the entries inside it, so destroy must restore
    // write permission first. Without that step this test fails with EACCES.
    const rootDirectory = await mkdtemp(join(tmpdir(), "factoree-readonly-"));
    const sandbox = new LocalProcessSandbox({ rootDirectory });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const created = await sandbox.exec(ref, {
      file: "sh",
      args: ["-c", "mkdir -p reference/design/.git && printf x > reference/design/.git/config && chmod -R a-w reference/design"],
    });
    expect(created.exitCode).toBe(0);
    // The checkpoint copy carries the same read-only mode, so destroy must handle it too.
    await sandbox.checkpoint(ref, "baseline");

    await sandbox.destroy(ref);

    expect(existsSync(join(rootDirectory, ref.id))).toBe(false);
    await rm(rootDirectory, { recursive: true, force: true });
  });

  it("copies the workspace into a checkpoint directory", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "factoree-checkpoint-"));
    const sandbox = new LocalProcessSandbox({ rootDirectory });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await sandbox.exec(ref, { file: "sh", args: ["-c", "printf baseline > marker"] });
    const checkpoint = await sandbox.checkpoint(ref, "baseline");
    await sandbox.exec(ref, { file: "sh", args: ["-c", "printf changed > marker"] });
    const saved = await readFile(join(rootDirectory, ref.id, "checkpoints", checkpoint.id, "marker"), "utf8");
    expect(saved).toBe("baseline");
    await rm(rootDirectory, { recursive: true, force: true });
  });
});
