import { describe, expect, it } from "vitest";
import {
  assertSameChangedFiles,
  capturePatch,
  PatchError,
  PATCH_DIFF_ARGS,
  sha256OfBase64,
} from "~/domain/publishing/patch.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { Command, CommandResult, Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";

const REF: SandboxRef = { id: "sprite-1", adapter: "local", workspacePath: "/w" };
const BASE = "a".repeat(40);

const stubSandbox = (script: (command: Command) => Partial<CommandResult>): { sandbox: Sandbox; calls: Command[] } => {
  const calls: Command[] = [];
  const sandbox = {
    name: "stub",
    capabilities: { enforcesNetworkPolicy: true, supportsCheckpoints: false, supportsExposedServices: false, supportsCustomImage: false },
    exec: (_ref: SandboxRef, command: Command): Promise<CommandResult> => {
      calls.push(command);
      return Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        durationMs: 1,
        ...script(command),
      });
    },
  } as unknown as Sandbox;
  return { sandbox, calls };
};

describe("capturePatch", () => {
  it("runs the SDD section 44 command pair with --binary and hashes the decoded bytes", async () => {
    const patch = "diff --git a/src/a.ts b/src/a.ts\n";
    const { sandbox, calls } = stubSandbox((command) => {
      if (command.args.includes("--name-only")) return { stdout: "src/a.ts\n" };
      if (command.args.includes('base64 < "$0"')) return { stdout: Buffer.from(patch).toString("base64") };
      if (command.args.includes("write-tree")) return { stdout: `${"b".repeat(40)}\n` };
      return { stdout: "" };
    });

    const result = await capturePatch(
      { sandbox, redactor: new Redactor([]) },
      { ref: REF, primaryPath: "/w/primary", baseSha: BASE },
    );

    expect(Buffer.from(result.patchBase64, "base64").toString("utf8")).toBe(patch);
    expect(result.patchSha256).toBe(sha256OfBase64(Buffer.from(patch).toString("base64")));
    expect(result.changedFiles).toEqual(["src/a.ts"]);
    expect(result.treeSha).toBe("b".repeat(40));
    // SDD section 44 fixes `git add -A` first. Factoree's own git runs it, with no user config,
    // so a filter, a monitor or a hook of the repository config cannot run. check-isolation.md.
    expect(calls[0]?.file).toBe("/usr/bin/git");
    expect(calls[0]?.args).toEqual([
      "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.sshCommand=false",
      "-C", "/w/primary", "add", "-A",
    ]);
    // The patch command carries --binary. DI-9.1.
    const patchCall = calls.find((call) => call.args.includes("--binary"));
    expect(patchCall).toBeDefined();
    expect(PATCH_DIFF_ARGS).toContain("--binary");
    expect(PATCH_DIFF_ARGS).toContain("--no-renames");
    expect(PATCH_DIFF_ARGS).toContain("--no-textconv");
  });

  it("refuses a base SHA that is not forty hexadecimal characters", async () => {
    const { sandbox } = stubSandbox(() => ({}));
    await expect(
      capturePatch({ sandbox, redactor: new Redactor([]) }, { ref: REF, primaryPath: "/w/primary", baseSha: "HEAD" }),
    ).rejects.toBeInstanceOf(PatchError);
  });

  it("redacts a Project secret out of a git failure message", async () => {
    const { sandbox } = stubSandbox((command) =>
      command.args.includes("add") ? { exitCode: 1, stderr: "fatal: token s3cret-value leaked" } : {},
    );
    await expect(
      capturePatch({ sandbox, redactor: new Redactor(["s3cret-value"]) }, { ref: REF, primaryPath: "/w/primary", baseSha: BASE }),
    ).rejects.toThrow(/\[REDACTED\]/);
  });

  it("reports an empty change with no changed file and an empty patch", async () => {
    const { sandbox } = stubSandbox((command) => (command.args.includes("write-tree") ? { stdout: `${"c".repeat(40)}\n` } : { stdout: "" }));
    const result = await capturePatch(
      { sandbox, redactor: new Redactor([]) },
      { ref: REF, primaryPath: "/w/primary", baseSha: BASE },
    );
    expect(result.changedFiles).toEqual([]);
    expect(result.byteLength).toBe(0);
  });

  it("records the git version of the sandbox that captured the patch (SDD section 46)", async () => {
    // The hash assertion of SDD section 46 compares two diff texts. Two git binaries can
    // produce two texts from one tree. The recorded version turns a silent mismatch into a
    // readable cause.
    const { sandbox } = stubSandbox((command) => {
      if (command.args.includes("write-tree")) return { stdout: `${"d".repeat(40)}\n` };
      if (command.args.includes("--version")) return { stdout: "git version 2.51.0\n" };
      return { stdout: "" };
    });
    const patch = await capturePatch(
      { sandbox, redactor: new Redactor([]) },
      { ref: REF, primaryPath: "/w/primary", baseSha: BASE },
    );
    expect(patch.gitVersion).toMatch(/^git version /);
  });
});

describe("assertSameChangedFiles", () => {
  it("accepts the same set in a different order", () => {
    expect(() => assertSameChangedFiles(["b.ts", "a.ts"], ["a.ts", "b.ts"])).not.toThrow();
  });

  it("refuses a file the Reviewer never saw", () => {
    expect(() => assertSameChangedFiles(["a.ts"], ["a.ts", "b.ts"])).toThrow(PatchError);
  });

  it("refuses a file the Reviewer saw and the patch dropped", () => {
    expect(() => assertSameChangedFiles(["a.ts", "b.ts"], ["a.ts"])).toThrow(PatchError);
  });
});
