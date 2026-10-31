import { describe, expect, it } from "vitest";
import { worktreeFingerprint } from "~/domain/review/source-diff.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { Command, CommandResult, Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";

const REF: SandboxRef = { id: "s", adapter: "local", workspacePath: "/w" };

const sandboxOf = (trees: string[]): Sandbox => {
  let index = 0;
  return {
    name: "stub",
    capabilities: { enforcesNetworkPolicy: true, supportsCheckpoints: false, supportsExposedServices: false, supportsCustomImage: false },
    exec: (_ref: SandboxRef, command: Command): Promise<CommandResult> =>
      Promise.resolve({
        exitCode: 0,
        stdout: command.args.includes("write-tree") ? `${trees[index++] ?? ""}\n` : "",
        stderr: "",
        timedOut: false,
        durationMs: 1,
      }),
  } as unknown as Sandbox;
};

describe("worktreeFingerprint", () => {
  it("returns the staged tree object of the primary worktree", async () => {
    const sandbox = sandboxOf(["a".repeat(40)]);
    const value = await worktreeFingerprint(
      { sandbox, redactor: new Redactor([]) },
      { ref: REF, primaryPath: "/w/primary" },
    );
    expect(value).toBe("a".repeat(40));
  });

  it("changes when the worktree content changes", async () => {
    const sandbox = sandboxOf(["a".repeat(40), "b".repeat(40)]);
    const first = await worktreeFingerprint({ sandbox, redactor: new Redactor([]) }, { ref: REF, primaryPath: "/w/primary" });
    const second = await worktreeFingerprint({ sandbox, redactor: new Redactor([]) }, { ref: REF, primaryPath: "/w/primary" });
    expect(first).not.toBe(second);
  });
});
