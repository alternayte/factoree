import { describe, expect, it, vi } from "vitest";
import { worktreeGitStateFingerprint } from "~/domain/review/source-diff.js";
import { Redactor } from "~/telemetry/redaction.js";

const ref = { id: "sandbox-1", workspacePath: "/w" } as never;

/** A sandbox double whose `exec` answers each git command from a script. */
const sandboxOf = (answers: Record<string, string>) => ({
  exec: vi.fn((_ref: unknown, command: { args: string[] }) => {
    const key = command.args.join(" ");
    const stdout = answers[key];
    if (stdout === undefined) throw new Error(`the test scripted no answer for: ${key}`);
    return Promise.resolve({ exitCode: 0, stdout, stderr: "" });
  }),
});

describe("worktreeGitStateFingerprint", () => {
  it("changes when HEAD moves", async () => {
    const base = {
      "-C /w/primary rev-parse HEAD": "a".repeat(40) + "\n",
      "-C /w/primary for-each-ref --format=%(objectname) %(refname)":
        "a".repeat(40) + " refs/heads/main\n",
    };
    const moved = {
      "-C /w/primary rev-parse HEAD": "b".repeat(40) + "\n",
      "-C /w/primary for-each-ref --format=%(objectname) %(refname)":
        "a".repeat(40) + " refs/heads/main\n",
    };
    const first = await worktreeGitStateFingerprint(
      { sandbox: sandboxOf(base) as never, redactor: new Redactor() },
      { ref, primaryPath: "/w/primary" },
    );
    const second = await worktreeGitStateFingerprint(
      { sandbox: sandboxOf(moved) as never, redactor: new Redactor() },
      { ref, primaryPath: "/w/primary" },
    );
    expect(second).not.toBe(first);
  });

  it("changes when a ref appears, so a new local branch cannot hide", async () => {
    const base = {
      "-C /w/primary rev-parse HEAD": "a".repeat(40) + "\n",
      "-C /w/primary for-each-ref --format=%(objectname) %(refname)":
        "a".repeat(40) + " refs/heads/main\n",
    };
    const extra = {
      "-C /w/primary rev-parse HEAD": "a".repeat(40) + "\n",
      "-C /w/primary for-each-ref --format=%(objectname) %(refname)":
        "a".repeat(40) + " refs/heads/main\n" + "c".repeat(40) + " refs/heads/sneaky\n",
    };
    const first = await worktreeGitStateFingerprint(
      { sandbox: sandboxOf(base) as never, redactor: new Redactor() },
      { ref, primaryPath: "/w/primary" },
    );
    const second = await worktreeGitStateFingerprint(
      { sandbox: sandboxOf(extra) as never, redactor: new Redactor() },
      { ref, primaryPath: "/w/primary" },
    );
    expect(second).not.toBe(first);
  });

  it("is stable across two reads of the same state", async () => {
    const answers = {
      "-C /w/primary rev-parse HEAD": "a".repeat(40) + "\n",
      "-C /w/primary for-each-ref --format=%(objectname) %(refname)":
        "a".repeat(40) + " refs/heads/main\n",
    };
    const first = await worktreeGitStateFingerprint(
      { sandbox: sandboxOf(answers) as never, redactor: new Redactor() },
      { ref, primaryPath: "/w/primary" },
    );
    const second = await worktreeGitStateFingerprint(
      { sandbox: sandboxOf(answers) as never, redactor: new Redactor() },
      { ref, primaryPath: "/w/primary" },
    );
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});
