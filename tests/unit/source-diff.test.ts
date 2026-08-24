import { describe, expect, it } from "vitest";
import { captureSourceDiff, SourceDiffError } from "~/domain/review/source-diff.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";

const ref = { id: "sprite-1", adapter: "local", workspacePath: "/workspace" };

/** Answers each recorded command with a fixed result, and records every call. */
const fakeSandbox = (answers: Array<{ match: string; stdout: string; exitCode?: number }>) => {
  const calls: string[] = [];
  const sandbox = {
    name: "fake",
    // eslint-disable-next-line @typescript-eslint/require-await -- the fake matches `exec`'s async signature, and returns no awaited value
    async exec(_ref: unknown, command: { file: string; args: string[] }) {
      const line = [command.file, ...command.args].join(" ");
      calls.push(line);
      const answer = answers.find((entry) => line.includes(entry.match));
      return {
        exitCode: answer?.exitCode ?? 0,
        stdout: answer?.stdout ?? "",
        stderr: "",
        timedOut: false,
        durationMs: 1,
      };
    },
  } as unknown as Sandbox;
  return { sandbox, calls };
};

const redactor = new Redactor(["s3cr3t-value-000"]);

describe("captureSourceDiff", () => {
  it("stages everything and diffs against the base SHA", async () => {
    const { sandbox, calls } = fakeSandbox([
      { match: "--name-only", stdout: "src/auth.ts\ntests/unit/auth.test.ts\n" },
      { match: "diff --cached", stdout: "diff --git a/src/auth.ts b/src/auth.ts\n" },
    ]);
    const diff = await captureSourceDiff(
      { sandbox, redactor },
      { ref, primaryPath: "/workspace/primary", baseSha: "a".repeat(40) },
    );
    expect(calls.some((line) => line.includes("add -A"))).toBe(true);
    expect(calls.some((line) => line.includes("a".repeat(40)))).toBe(true);
    expect(diff.changedFiles).toEqual(["src/auth.ts", "tests/unit/auth.test.ts"]);
    expect(diff.text).toContain("diff --git");
    expect(diff.truncated).toBe(false);
  });

  it("redacts a Project secret out of the diff", async () => {
    const { sandbox } = fakeSandbox([
      { match: "--name-only", stdout: "src/auth.ts\n" },
      { match: "diff --cached", stdout: "+const token = \"s3cr3t-value-000\";\n" },
    ]);
    const diff = await captureSourceDiff(
      { sandbox, redactor },
      { ref, primaryPath: "/workspace/primary", baseSha: "a".repeat(40) },
    );
    expect(diff.text).not.toContain("s3cr3t-value-000");
  });

  it("truncates a diff above the ceiling and says so", async () => {
    const { sandbox } = fakeSandbox([
      { match: "--name-only", stdout: "src/auth.ts\n" },
      { match: "diff --cached", stdout: "x".repeat(5_000) },
    ]);
    const diff = await captureSourceDiff(
      { sandbox, redactor },
      { ref, primaryPath: "/workspace/primary", baseSha: "a".repeat(40), maxBytes: 1_000 },
    );
    expect(diff.truncated).toBe(true);
    expect(diff.text.length).toBeLessThan(2_000);
    expect(diff.text).toContain("truncated");
  });

  it("reports an empty change with no file", async () => {
    const { sandbox } = fakeSandbox([
      { match: "--name-only", stdout: "" },
      { match: "diff --cached", stdout: "" },
    ]);
    const diff = await captureSourceDiff(
      { sandbox, redactor },
      { ref, primaryPath: "/workspace/primary", baseSha: "a".repeat(40) },
    );
    expect(diff.changedFiles).toEqual([]);
    expect(diff.text).toContain("no change");
  });

  it("throws when git fails", async () => {
    const { sandbox } = fakeSandbox([{ match: "add -A", stdout: "", exitCode: 128 }]);
    await expect(
      captureSourceDiff(
        { sandbox, redactor },
        { ref, primaryPath: "/workspace/primary", baseSha: "a".repeat(40) },
      ),
    ).rejects.toBeInstanceOf(SourceDiffError);
  });

  it("refuses a base SHA that is not forty hexadecimal characters", async () => {
    const { sandbox } = fakeSandbox([]);
    await expect(
      captureSourceDiff(
        { sandbox, redactor },
        { ref, primaryPath: "/workspace/primary", baseSha: "not-a-sha" },
      ),
    ).rejects.toBeInstanceOf(SourceDiffError);
  });
});
