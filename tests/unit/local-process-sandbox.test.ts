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
