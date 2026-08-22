import { describe, expect, it } from "vitest";
import { checkoutRepositories } from "~/domain/runs/checkout.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const input = {
  primary: { url: "https://github.com/acme/app.git", ref: "main" },
  references: [{ url: "https://github.com/acme/design.git", ref: "main" }],
};

describe("checkoutRepositories", () => {
  it("clones the primary repository and captures its base SHA", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const result = await checkoutRepositories(sandbox, ref, input);
    expect(result.primary.baseSha).toBe("aaaabbbbccccddddeeeeffff0000111122223333");
    expect(result.primary.path).toBe("/workspace/primary");
  });

  it("clones every reference repository under its own directory", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const result = await checkoutRepositories(sandbox, ref, input);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]?.path).toBe("/workspace/reference/design");
  });

  it("removes the push URL of the primary repository, because SDD section 29 denies git remote write", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await checkoutRepositories(sandbox, ref, input);
    const lines = sandbox.commands.map((command) => [command.file, ...command.args].join(" "));
    expect(lines.some((line) => line.includes("remote set-url --push origin DISABLED_BY_FACTOREE"))).toBe(true);
  });

  it("makes every reference repository read-only", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await checkoutRepositories(sandbox, ref, input);
    const lines = sandbox.commands.map((command) => [command.file, ...command.args].join(" "));
    expect(lines).toContain("chmod -R a-w /workspace/reference/design");
  });

  it("clones the primary repository before it clones a reference repository", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await checkoutRepositories(sandbox, ref, input);
    const lines = sandbox.commands.map((command) => [command.file, ...command.args].join(" "));
    const primaryIndex = lines.findIndex((line) => line.includes("acme/app.git"));
    const referenceIndex = lines.findIndex((line) => line.includes("acme/design.git"));
    expect(primaryIndex).toBeGreaterThanOrEqual(0);
    expect(primaryIndex).toBeLessThan(referenceIndex);
  });

  it("fails when the clone of the primary repository fails", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/clone/, { exitCode: 128, stderr: "repository not found" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await expect(checkoutRepositories(sandbox, ref, input)).rejects.toThrow(/repository not found/);
  });

  it("rejects a base SHA that is not forty hexadecimal characters", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "not-a-sha\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await expect(checkoutRepositories(sandbox, ref, input)).rejects.toThrow(/base SHA/);
  });
});
