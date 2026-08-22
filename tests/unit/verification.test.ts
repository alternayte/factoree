import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { Redactor } from "~/telemetry/redaction.js";
import { MAX_RETAINED_LOG_BYTES, runVerification } from "~/domain/runs/verification.js";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const prepare = async (results: Record<string, { exitCode: number; stdout: string; stderr: string }>) => {
  const sandbox = new FakeSandbox();
  sandbox.onExec = (command) =>
    results[command.args[command.args.length - 1] ?? ""] ?? { exitCode: 0, stdout: "", stderr: "" };
  const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
  return { sandbox, ref };
};

const base = { workingDirectory: "/w/primary", environment: {}, timeoutMs: 60_000 };

describe("runVerification", () => {
  it("records the SDD section 35 fields for each command", async () => {
    const { sandbox, ref } = await prepare({ "npm test": { exitCode: 0, stdout: "ok\n", stderr: "" } });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      redactor: new Redactor(),
    });
    expect(outcome.passed).toBe(true);
    const check = outcome.checks[0];
    expect(check?.name).toBe("test");
    expect(check?.command).toBe("npm test");
    expect(check?.exitCode).toBe(0);
    expect(check?.stdoutSha256).toBe(sha("ok\n"));
    expect(check?.stderrSha256).toBe(sha(""));
    expect(check?.passed).toBe(true);
    expect(Date.parse(check?.startedAt ?? "")).not.toBeNaN();
    expect(Date.parse(check?.endedAt ?? "")).not.toBeNaN();
  });

  it("passes only on exit code 0", async () => {
    const { sandbox, ref } = await prepare({ "npm test": { exitCode: 1, stdout: "", stderr: "boom\n" } });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      redactor: new Redactor(),
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.checks[0]?.passed).toBe(false);
    expect(outcome.checks[0]?.exitCode).toBe(1);
  });

  it("runs every command even after one fails", async () => {
    const { sandbox, ref } = await prepare({
      a: { exitCode: 1, stdout: "", stderr: "" },
      b: { exitCode: 0, stdout: "", stderr: "" },
    });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [
        { name: "first", run: "a" },
        { name: "second", run: "b" },
      ],
      redactor: new Redactor(),
    });
    expect(outcome.checks.map((check) => check.name)).toEqual(["first", "second"]);
    expect(outcome.passed).toBe(false);
  });

  it("runs each command from a clean shell in the primary worktree", async () => {
    const { sandbox, ref } = await prepare({});
    await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      environment: { FIXTURE_TOKEN: "value-1234" },
      timeoutMs: 42_000,
      redactor: new Redactor(),
    });
    const command = sandbox.commands.at(-1);
    expect(command?.file).toBe("sh");
    expect(command?.args).toEqual(["-c", "npm test"]);
    expect(command?.cwd).toBe("/w/primary");
    expect(command?.timeoutMs).toBe(42_000);
    expect(Object.keys(command?.env ?? {}).sort()).toEqual(["FIXTURE_TOKEN", "HOME", "LANG", "PATH"]);
  });

  it("hashes the raw output and redacts the retained log", async () => {
    const { sandbox, ref } = await prepare({
      "npm test": { exitCode: 1, stdout: "token=value-1234\n", stderr: "" },
    });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      redactor: new Redactor(["value-1234"]),
    });
    expect(outcome.checks[0]?.stdoutSha256).toBe(sha("token=value-1234\n"));
    expect(outcome.checks[0]?.log).not.toContain("value-1234");
    expect(outcome.checks[0]?.log).toContain("[REDACTED]");
  });

  it("retains a log only for a failing command", async () => {
    const { sandbox, ref } = await prepare({ "npm test": { exitCode: 0, stdout: "lots\n", stderr: "" } });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      redactor: new Redactor(),
    });
    expect(outcome.checks[0]?.log).toBeNull();
  });

  it("truncates a very large retained log but still hashes the whole output", async () => {
    const big = "x".repeat(MAX_RETAINED_LOG_BYTES + 1_000);
    const { sandbox, ref } = await prepare({ "npm test": { exitCode: 1, stdout: big, stderr: "" } });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      redactor: new Redactor(),
    });
    const log = outcome.checks[0]?.log ?? "";
    expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(MAX_RETAINED_LOG_BYTES + 200);
    expect(log).toContain("truncated");
    expect(outcome.checks[0]?.stdoutSha256).toBe(sha(big));
  });

  it("redacts a secret before truncation, even when the secret straddles the old cut point", async () => {
    // Builds output large enough that the retained log must be truncated, with a secret placed
    // so that a truncate-then-redact order would cut the secret in half at the byte boundary.
    // The surviving half then matches no exact secret value and no provider credential pattern,
    // and it stays in the text. Redaction must run on the complete output first.
    const header = "--- stdout ---\n";
    const middle = "\n--- stderr ---\n";
    const trailer = "\n";
    const secret = "straddle-secret-value-12345";
    const stderr = "";
    const halfSecret = Math.floor(secret.length / 2);
    const targetRemovedFromFront = header.length + halfSecret;
    const fixedLen = header.length + middle.length + stderr.length + trailer.length;
    const padLen = MAX_RETAINED_LOG_BYTES + targetRemovedFromFront - fixedLen - secret.length;
    const stdout = secret + "y".repeat(padLen);

    const { sandbox, ref } = await prepare({ "npm test": { exitCode: 1, stdout, stderr } });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      redactor: new Redactor([secret]),
    });

    const log = outcome.checks[0]?.log ?? "";
    // No form of the secret, whole or split, must survive into the retained log.
    expect(log).not.toContain(secret);
    for (let cut = 4; cut < secret.length - 4; cut += 1) {
      expect(log).not.toContain(secret.slice(cut));
      expect(log).not.toContain(secret.slice(0, cut));
    }
    expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(MAX_RETAINED_LOG_BYTES + 200);
    expect(log).toContain("truncated");
    // The hash covers the raw, unredacted output. Redaction must never change what the hash
    // identifies as the command that really ran.
    expect(outcome.checks[0]?.stdoutSha256).toBe(sha(stdout));
  });

  it("records a command the sandbox could not run as a failure", async () => {
    const sandbox = new FakeSandbox();
    sandbox.onExec = () => {
      throw new Error("the sandbox is gone");
    };
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      redactor: new Redactor(),
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.checks[0]?.exitCode).toBe(-1);
    expect(outcome.checks[0]?.log).toContain("the sandbox is gone");
  });

  it("reports a timeout as a failure", async () => {
    const sandbox = new FakeSandbox();
    sandbox.onExec = () => ({ exitCode: 124, stdout: "", stderr: "", timedOut: true });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      timeoutMs: 1_000,
      redactor: new Redactor(),
    });
    expect(outcome.checks[0]?.timedOut).toBe(true);
    expect(outcome.checks[0]?.passed).toBe(false);
  });

  it("stays total on an empty command list", async () => {
    const { sandbox, ref } = await prepare({});
    const outcome = await runVerification({ ...base, sandbox, ref, commands: [], redactor: new Redactor() });
    // The schema of Task 1 already refuses an empty list, so this case cannot come from a
    // repository. The function returns rather than throwing. The outcome still reports a
    // failure, because this function is the single control that makes the Phase 3 exit
    // condition true, and a vacuous pass must stay impossible, not merely unreachable.
    expect(outcome.checks).toEqual([]);
    expect(outcome.passed).toBe(false);
  });
});
