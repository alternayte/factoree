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

  it("clones without a hardlink, so no checkout shares an inode with its source", async () => {
    // A clone of a local path hardlinks object files by default. The read-only control on a
    // reference checkout would then change the mode of an inode the source repository still
    // shares, and a sandbox must never change anything outside itself.
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await checkoutRepositories(sandbox, ref, input);
    const clones = sandbox.commands.filter((command) => command.args.includes("clone"));
    expect(clones).toHaveLength(2);
    for (const clone of clones) expect(clone.args).toContain("--no-hardlinks");
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

describe("checkoutRepositories path safety", () => {
  it("rejects a reference repository URL whose derived name is the parent directory", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const badInput = {
      primary: { url: "https://github.com/acme/app.git", ref: "main" },
      references: [{ url: "https://github.com/acme/..", ref: "main" }],
    };
    await expect(checkoutRepositories(sandbox, ref, badInput)).rejects.toThrow(/not allowed/);
  });

  it("rejects a reference repository URL whose derived name is the current directory", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const badInput = {
      primary: { url: "https://github.com/acme/app.git", ref: "main" },
      references: [{ url: "https://github.com/acme/.", ref: "main" }],
    };
    await expect(checkoutRepositories(sandbox, ref, badInput)).rejects.toThrow(/not allowed/);
  });

  it("rejects a URL that ends in a trailing slash, because the derived name is empty", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const badInput = {
      primary: { url: "https://github.com/acme/app.git", ref: "main" },
      references: [{ url: "https://github.com/acme/design/", ref: "main" }],
    };
    await expect(checkoutRepositories(sandbox, ref, badInput)).rejects.toThrow(/usable directory name/);
  });

  it("derives a usable directory name from an SSH-style URL", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const sshInput = {
      primary: { url: "https://github.com/acme/app.git", ref: "main" },
      references: [{ url: "git@github.com:acme/design.git", ref: "main" }],
    };
    const result = await checkoutRepositories(sandbox, ref, sshInput);
    expect(result.references[0]?.path).toBe("/workspace/reference/design");
  });

  it("fails before any clone when two reference repositories derive the same directory name", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const collidingInput = {
      primary: { url: "https://github.com/acme/app.git", ref: "main" },
      references: [
        { url: "https://github.com/acme/design.git", ref: "main" },
        { url: "https://gitlab.com/other/design.git", ref: "main" },
      ],
    };
    await expect(checkoutRepositories(sandbox, ref, collidingInput)).rejects.toThrow(
      /both derive the directory name "design"/,
    );
    const cloneCount = sandbox.commands.filter((command) => command.args.includes("clone")).length;
    expect(cloneCount).toBe(1);
  });
});
