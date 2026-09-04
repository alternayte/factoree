import { describe, expect, it } from "vitest";
import { checkoutOrganizationSkills, checkoutPrimary, checkoutRepositories } from "~/domain/runs/checkout.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const input = {
  primary: { url: "https://github.com/acme/app.git", ref: "main" },
  references: [{ url: "https://github.com/acme/design.git", ref: "main" }],
};

describe("checkoutRepositories", () => {
  it("clones the primary repository and captures its base SHA", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
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
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    await checkoutRepositories(sandbox, ref, input);
    const clones = sandbox.commands.filter((command) => command.args.includes("clone"));
    expect(clones).toHaveLength(2);
    for (const clone of clones) expect(clone.args).toContain("--no-hardlinks");
  });

  it("fetches the tags, because a ref can be a tag", async () => {
    // `--no-tags` was removed. A clone without tags leaves `git checkout --detach <tag>` with
    // nothing to resolve, and git then reads the tag as a path and fails.
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    await checkoutRepositories(sandbox, ref, input);
    const clones = sandbox.commands.filter((command) => command.args.includes("clone"));
    for (const clone of clones) expect(clone.args).not.toContain("--no-tags");
  });

  it("keeps the access token of a clone URL out of the error of a failed clone", async () => {
    // SDD section 60. The error escapes into Temporal history, which is external persistence.
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/clone/, {
      exitCode: 128,
      stderr: "fatal: could not read from https://x-access-token:ghp_realtokenvalue000000000@github.com/acme/app.git",
    });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    const withToken = {
      primary: { url: "https://x-access-token:ghp_realtokenvalue000000000@github.com/acme/app.git", ref: "main" },
      references: [],
    };
    const error = await checkoutRepositories(sandbox, ref, withToken).catch((thrown: unknown) => thrown);
    const message = String(error);
    expect(message).not.toContain("ghp_realtokenvalue000000000");
    expect(message).not.toContain("x-access-token");
    expect(message).toContain("github.com/acme/app.git");
  });

  it("reports a ref that git cannot resolve as a configuration fault", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/checkout --detach/, { exitCode: 128, stderr: "fatal: invalid reference: v9" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    await expect(checkoutRepositories(sandbox, ref, input)).rejects.toBeInstanceOf(RunConfigurationError);
  });

  it("clones every reference repository under its own directory", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    const result = await checkoutRepositories(sandbox, ref, input);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]?.path).toBe("/workspace/reference/design");
  });

  it("removes the push URL of the primary repository, because SDD section 29 denies git remote write", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    await checkoutRepositories(sandbox, ref, input);
    const lines = sandbox.commands.map((command) => [command.file, ...command.args].join(" "));
    expect(lines.some((line) => line.includes("remote set-url --push origin DISABLED_BY_FACTOREE"))).toBe(true);
  });

  it("makes every reference repository read-only", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    await checkoutRepositories(sandbox, ref, input);
    const lines = sandbox.commands.map((command) => [command.file, ...command.args].join(" "));
    expect(lines).toContain("chmod -R a-w /workspace/reference/design");
  });

  it("clones the primary repository before it clones a reference repository", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
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
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    await expect(checkoutRepositories(sandbox, ref, input)).rejects.toThrow(/repository not found/);
  });

  it("rejects a base SHA that is not forty hexadecimal characters", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "not-a-sha\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    await expect(checkoutRepositories(sandbox, ref, input)).rejects.toThrow(/base SHA/);
  });
});

describe("checkoutRepositories path safety", () => {
  it("rejects a reference repository URL whose derived name is the parent directory", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    const badInput = {
      primary: { url: "https://github.com/acme/app.git", ref: "main" },
      references: [{ url: "https://github.com/acme/..", ref: "main" }],
    };
    await expect(checkoutRepositories(sandbox, ref, badInput)).rejects.toThrow(/not allowed/);
  });

  it("rejects a reference repository URL whose derived name is the current directory", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    const badInput = {
      primary: { url: "https://github.com/acme/app.git", ref: "main" },
      references: [{ url: "https://github.com/acme/.", ref: "main" }],
    };
    await expect(checkoutRepositories(sandbox, ref, badInput)).rejects.toThrow(/not allowed/);
  });

  it("rejects a URL that ends in a trailing slash, because the derived name is empty", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    const badInput = {
      primary: { url: "https://github.com/acme/app.git", ref: "main" },
      references: [{ url: "https://github.com/acme/design/", ref: "main" }],
    };
    await expect(checkoutRepositories(sandbox, ref, badInput)).rejects.toThrow(/usable directory name/);
  });

  it("derives a usable directory name from an SSH-style URL", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    const sshInput = {
      primary: { url: "https://github.com/acme/app.git", ref: "main" },
      references: [{ url: "git@github.com:acme/design.git", ref: "main" }],
    };
    const result = await checkoutRepositories(sandbox, ref, sshInput);
    expect(result.references[0]?.path).toBe("/workspace/reference/design");
  });

  it("rejects the same reference repository URL twice, even at two different refs", async () => {
    // Both entries resolve to one directory. Git would report a directory that exists, and that
    // message names nothing an operator can act on.
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    const duplicateInput = {
      primary: { url: "https://github.com/acme/app.git", ref: "main" },
      references: [
        { url: "https://github.com/acme/design.git", ref: "main" },
        { url: "https://github.com/acme/design.git", ref: "v1.0.0" },
      ],
    };
    const error = await checkoutRepositories(sandbox, ref, duplicateInput).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(RunConfigurationError);
    expect(String(error)).toMatch(/appears more than once/);
    // The check runs before the first reference clone, so only the primary was cloned.
    expect(sandbox.commands.filter((command) => command.args.includes("clone"))).toHaveLength(1);
  });

  it("fails before any clone when two reference repositories derive the same directory name", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    const collidingInput = {
      primary: { url: "https://github.com/acme/app.git", ref: "main" },
      references: [
        { url: "https://github.com/acme/design.git", ref: "main" },
        { url: "https://gitlab.com/other/design.git", ref: "main" },
      ],
    };
    const error = await checkoutRepositories(sandbox, ref, collidingInput).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(RunConfigurationError);
    expect(String(error)).toMatch(/both derive the directory name "design"/);
    const cloneCount = sandbox.commands.filter((command) => command.args.includes("clone")).length;
    expect(cloneCount).toBe(1);
  });
});

describe("checkoutOrganizationSkills", () => {
  it("checks out the organization skills repository read-only into its own directory", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    const checked = await checkoutOrganizationSkills(sandbox, ref, {
      url: "https://git/acme/skills.git",
      ref: "main",
    });
    expect(checked.path).toBe(`${ref.workspacePath}/organization-skills`);
    expect(checked.readOnly).toBe(true);
    expect(
      sandbox.commands.some((command) => command.file === "chmod" && command.args.includes(checked.path)),
    ).toBe(true);
  });
});

describe("the read-only repository credential", () => {
  it("reaches the clone command alone, and never the command line", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    sandbox.onExec = (command) =>
      command.args.includes("rev-parse")
        ? { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" };

    await checkoutPrimary(
      sandbox,
      ref,
      { url: "https://github.test/acme/app.git", ref: "main" },
      "read-only-token",
    );

    const clone = sandbox.commands.find((command) => command.args.includes("clone"));
    expect(clone?.env?.GIT_CONFIG_COUNT).toBe("1");
    expect(clone?.env?.GIT_CONFIG_KEY_0).toBe("http.https://github.test/.extraheader");
    // The credential must never sit where `ps` or `/proc/<pid>/cmdline` can show it.
    for (const command of sandbox.commands) {
      expect([command.file, ...command.args].join(" ")).not.toContain("read-only-token");
    }
    // Every command after the clone runs without the credential, so nothing writes it into the
    // checkout, and the origin URL stays bare.
    for (const command of sandbox.commands.filter((entry) => !entry.args.includes("clone"))) {
      expect(command.env?.GIT_CONFIG_VALUE_0).toBeUndefined();
    }
  });

  it("sends no credential environment for a public repository", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    sandbox.onExec = (command) =>
      command.args.includes("rev-parse")
        ? { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" };

    await checkoutPrimary(sandbox, ref, { url: "https://github.test/acme/app.git", ref: "main" });

    const clone = sandbox.commands.find((command) => command.args.includes("clone"));
    expect(clone?.env).toBeUndefined();
  });
});
