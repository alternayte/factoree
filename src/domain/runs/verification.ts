import { createHash } from "node:crypto";
import type { Sandbox, SandboxRef } from "./sandbox.js";
import type { VerificationCommand } from "./project-runtime-config.js";
import type { Redactor } from "~/telemetry/redaction.js";

/**
 * SDD section 35. After implementation, Factoree runs the configured commands from a clean
 * shell and records the exact result of each one. Only exit code 0 passes, and an agent claim
 * never affects the result.
 */

/** The largest retained log Factoree keeps for one failing command. */
export const MAX_RETAINED_LOG_BYTES = 32 * 1024;

/**
 * The environment of a clean shell. SDD section 35 says "clean shell", so a verification
 * command inherits nothing from the Implementer. `PATH` is needed to find an executable, `HOME`
 * is needed by most toolchains, and `LANG` keeps output deterministic.
 */
const CLEAN_SHELL_ENV: Record<string, string> = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/root",
  LANG: "C.UTF-8",
};

export interface VerificationCheckResult {
  name: string;
  /** The exact command, as SDD section 35 requires. */
  command: string;
  startedAt: string;
  endedAt: string;
  exitCode: number;
  stdoutSha256: string;
  stderrSha256: string;
  /** The retained, redacted log. Null when nothing was retained. */
  log: string | null;
  timedOut: boolean;
  durationMs: number;
  /** Only exit code 0 passes. SDD section 35. */
  passed: boolean;
}

export interface VerificationOutcome {
  passed: boolean;
  checks: VerificationCheckResult[];
}

export interface RunVerificationOptions {
  sandbox: Sandbox;
  ref: SandboxRef;
  workingDirectory: string;
  commands: VerificationCommand[];
  /** Project test secrets the operator marked for injection. SDD section 30. */
  environment: Record<string, string>;
  timeoutMs: number;
  redactor: Redactor;
  now?: () => Date;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Keeps the tail of a text, because a failure appears at the end of a build log. */
const tail = (text: string): string => {
  if (Buffer.byteLength(text, "utf8") <= MAX_RETAINED_LOG_BYTES) return text;
  const kept = Buffer.from(text, "utf8").subarray(-MAX_RETAINED_LOG_BYTES).toString("utf8");
  return `[Factoree truncated this log to the last ${MAX_RETAINED_LOG_BYTES} bytes.]\n${kept}`;
};

/**
 * Builds the retained log of a failing command. SDD section 60 requires redaction before any
 * text leaves the sandbox. The hashes cover the raw output, so the redaction here cannot weaken
 * the record of what really ran.
 */
const buildLog = (redactor: Redactor, stdout: string, stderr: string): string =>
  redactor.redactText(tail(`--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`));

export const runVerification = async (options: RunVerificationOptions): Promise<VerificationOutcome> => {
  const now = options.now ?? (() => new Date());
  const checks: VerificationCheckResult[] = [];

  for (const command of options.commands) {
    const startedAt = now();
    let exitCode = -1;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let durationMs = 0;

    try {
      const result = await options.sandbox.exec(options.ref, {
        file: "sh",
        args: ["-c", command.run],
        cwd: options.workingDirectory,
        // SDD section 30. Only a Project test secret the operator marked for injection may
        // appear here. Nothing of the Implementer environment survives into this shell.
        env: { ...CLEAN_SHELL_ENV, ...options.environment },
        timeoutMs: options.timeoutMs,
      });
      exitCode = result.exitCode;
      stdout = result.stdout;
      stderr = result.stderr;
      timedOut = result.timedOut;
      durationMs = result.durationMs;
    } catch (error) {
      // A sandbox that cannot run a command has proved nothing. The check fails, and the fault
      // is recorded rather than thrown, so every other command still produces a record.
      stderr = error instanceof Error ? error.message : String(error);
      exitCode = -1;
    }

    const endedAt = now();
    // SDD section 35. Only exit code 0 passes.
    const passed = exitCode === 0 && !timedOut;
    checks.push({
      name: command.name,
      command: command.run,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      exitCode,
      stdoutSha256: sha256(stdout),
      stderrSha256: sha256(stderr),
      // A passing command produces no log. A failing command must explain itself to a human and
      // to the repair attempt.
      log: passed ? null : buildLog(options.redactor, stdout, stderr),
      timedOut,
      durationMs: durationMs === 0 ? endedAt.getTime() - startedAt.getTime() : durationMs,
      passed,
    });
  }

  return { passed: checks.every((check) => check.passed), checks };
};
