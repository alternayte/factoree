import { createHash } from "node:crypto";
import type { Sandbox, SandboxRef } from "./sandbox.js";
import type { VerificationCommand } from "./project-runtime-config.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { buildRetainedLog, MAX_RETAINED_LOG_BYTES } from "~/domain/runs/retained-log.js";

export { MAX_RETAINED_LOG_BYTES };

/**
 * SDD section 35. After implementation, Factoree runs the configured commands from a clean
 * shell and records the exact result of each one. Only exit code 0 passes, and an agent claim
 * never affects the result.
 */

/** The largest retained log Factoree keeps for one failing command. */


/**
 * The environment of a clean shell. SDD section 35 says "clean shell", so a verification command
 * inherits nothing of an agent session. `isolated` on the command drops the environment attached
 * to the sandbox, which is where a runner credential lives.
 *
 * `PATH` and `HOME` are deliberately absent. They belong to the sandbox, and only the adapter
 * knows the right values: a Fly Sprite keeps its toolchain in `/.sprite/bin` and runs as the
 * `sprite` user, so a hard-coded `PATH` of the usual system directories found no `npm`, and a
 * hard-coded `HOME` of `/root` named a directory the command cannot write. `LANG` stays, because
 * it decides how a tool formats its output and a deterministic check needs that fixed.
 */
const CLEAN_SHELL_ENV: Record<string, string> = {
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
        isolated: true,
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
      log: passed ? null : buildRetainedLog(options.redactor, stdout, stderr),
      timedOut,
      durationMs: durationMs === 0 ? endedAt.getTime() - startedAt.getTime() : durationMs,
      passed,
    });
  }

  // An empty check list must not report a pass. The schema of Task 1 already refuses an empty
  // command list, so this case cannot come from a repository today. This function is still the
  // single control that makes the Phase 3 exit condition true, so a vacuous pass must stay
  // impossible here, rather than merely unreachable at the caller.
  const passed = checks.length > 0 && checks.every((check) => check.passed);
  return { passed, checks };
};
