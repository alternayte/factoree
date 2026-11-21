import type { Sandbox, SandboxRef } from "./sandbox.js";
import { recordRunEvent, type RunEventRecorder, type RunEventSubject } from "~/domain/diagnostics/run-event.js";

/**
 * docs/specs/sandbox-memory-and-size.md, DI-21.195. A Factoree check that the kernel killed out of
 * memory, or that hit a full disk, is a sandbox fault. It is not a code failure, so it spends no
 * repair. Rootless Docker runs without cgroups, so the kernel log is the only proof of an
 * out-of-memory kill; exit 137 alone can also be a stop.
 */

export const RESOURCE_SAMPLER = "/opt/factoree/bin/factoree-resource-sampler";
const PEAK_FILE = "/tmp/factoree-peak";

/** The peaks the resource sampler kept, in MB. */
export interface SandboxPeak {
  memoryMb: number;
  diskMb: number;
  totalMemoryMb: number;
  totalDiskMb: number;
}

export type SandboxFault =
  | { kind: "sandbox_out_of_memory"; killed: string[]; kernelLines: string[] }
  | { kind: "sandbox_disk_full"; kernelLines: string[] };

/** What a failed check gives the classifier. */
export interface FailedCheck {
  /** Null when the step reports no exit code, as a compose stack that did not start. */
  exitCode: number | null;
  /** True when Factoree stopped the check itself, at its timeout or on a cancel. */
  stoppedByFactoree: boolean;
  output: string;
}

/** The result of a look at a failed check. `unproven` names an exit 137 with no kernel log. */
export type SandboxFaultReading = { fault: SandboxFault } | { fault: null; note: string | null };

export const KERNEL_LOG_NOT_AVAILABLE = "The kernel log is not available, so Factoree did not check for an out-of-memory kill.";

const KILL_LINE = /Out of memory: Killed process (\d+) \(([^)]*)\)|Memory cgroup out of memory: Killed process (\d+) \(([^)]*)\)/;
const DISK_FULL = /ENOSPC|No space left on device/;

/** True when a failed check is worth a read of the kernel log. A passing check never is. */
export const mayBeSandboxFault = (check: FailedCheck): boolean =>
  !check.stoppedByFactoree && (check.exitCode === 137 || check.exitCode === null || DISK_FULL.test(check.output));

/**
 * The fault of a failed check, from its result and the kernel log. A kill line with exit 137 is
 * out of memory: a sandbox fault ends the run, so the log of a sandbox holds the kills of at most
 * one fault. A disk-full message in the output is a full disk.
 */
export const classifySandboxFault = (check: FailedCheck, kernelLines: readonly string[] | null): SandboxFaultReading => {
  if (check.stoppedByFactoree) return { fault: null, note: null };
  if (check.exitCode === 137 || check.exitCode === null) {
    if (kernelLines === null) return { fault: null, note: check.exitCode === 137 ? KERNEL_LOG_NOT_AVAILABLE : null };
    const lines = kernelLines.filter((line) => KILL_LINE.test(line));
    if (lines.length > 0) {
      return { fault: { kind: "sandbox_out_of_memory", killed: killedOf(lines), kernelLines: lines.slice(-10) } };
    }
  }
  if (DISK_FULL.test(check.output)) {
    const lines = (kernelLines ?? []).filter((line) => DISK_FULL.test(line) || /EXT4-fs.*(error|warning)/i.test(line));
    return { fault: { kind: "sandbox_disk_full", kernelLines: lines.slice(-10) } };
  }
  return { fault: null, note: null };
};

/** The processes the kill lines name, as "name (pid N)". */
export const killedOf = (kernelLines: readonly string[]): string[] => [
  ...new Set(
    kernelLines
      .map((line) => KILL_LINE.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => `${match[2] ?? match[4]} (pid ${match[1] ?? match[3]})`),
  ),
];

/** The higher of two peaks, field by field. */
export const higherPeak = (left: SandboxPeak | null, right: SandboxPeak): SandboxPeak =>
  left === null
    ? right
    : {
        memoryMb: Math.max(left.memoryMb, right.memoryMb),
        diskMb: Math.max(left.diskMb, right.diskMb),
        totalMemoryMb: Math.max(left.totalMemoryMb, right.totalMemoryMb),
        totalDiskMb: Math.max(left.totalDiskMb, right.totalDiskMb),
      };

/** Reads the kernel log only when the failed check may be a sandbox fault, then classifies it. */
export const readSandboxFault = async (sandbox: Sandbox, ref: SandboxRef, check: FailedCheck): Promise<SandboxFaultReading> => {
  if (!mayBeSandboxFault(check)) return { fault: null, note: null };
  const lines = sandbox.kernelLog === undefined ? null : await sandbox.kernelLog(ref).catch(() => null);
  return classifySandboxFault(check, lines);
};

/** Starts the resource sampler. A sandbox without the Factoree image has none, which is no fault. */
export const startResourceSampler = async (sandbox: Sandbox, ref: SandboxRef): Promise<void> => {
  if (!sandbox.capabilities.supportsCustomImage) return;
  await sandbox.startProcess(ref, { file: RESOURCE_SAMPLER, args: [], cwd: "/" }).catch(() => undefined);
};

/** Parses the line the sampler writes. Null for a missing or malformed file. */
export const parseSandboxPeak = (text: string): SandboxPeak | null => {
  const fields = text.trim().split(/\s+/).map(Number);
  if (fields.length !== 4 || fields.some((field) => !Number.isInteger(field) || field < 0)) return null;
  const [memoryMb, diskMb, totalMemoryMb, totalDiskMb] = fields as [number, number, number, number];
  return { memoryMb, diskMb, totalMemoryMb, totalDiskMb };
};

/** The peaks of a sandbox, or null when the sampler wrote none. */
export const readSandboxPeak = async (sandbox: Sandbox, ref: SandboxRef): Promise<SandboxPeak | null> => {
  if (!sandbox.capabilities.supportsCustomImage) return null;
  const result = await sandbox.exec(ref, { file: "cat", args: [PEAK_FILE], cwd: "/", timeoutMs: 10_000 }).catch(() => null);
  return result === null || result.exitCode !== 0 ? null : parseSandboxPeak(result.stdout);
};

/** One sentence for a run event and the failure post. */
export const sandboxFaultSentence = (input: { fault: SandboxFault; subject: string; peak: SandboxPeak | null }): string => {
  const peak =
    input.peak === null
      ? ""
      : input.fault.kind === "sandbox_out_of_memory"
        ? ` The sandbox used at most ${input.peak.memoryMb} MB of its ${input.peak.totalMemoryMb} MB.`
        : ` The sandbox used at most ${input.peak.diskMb} MB of its ${input.peak.totalDiskMb} MB disk.`;
  const what =
    input.fault.kind === "sandbox_out_of_memory"
      ? `The kernel stopped ${input.subject} out of memory: it killed ${input.fault.killed.join(", ")}.`
      : `${input.subject.charAt(0).toUpperCase()}${input.subject.slice(1)} hit a full disk.`;
  return `${what}${peak} This is a sandbox fault, not a code failure, so Factoree spends no repair on it.`;
};

/**
 * docs/specs/sandbox-memory-and-size.md. What Factoree does after a sandbox fault of a run: it
 * starts a setup run of the repository with the fault as input, unless one is open. The worker
 * wires it; a test or a build-ahead leaves it out.
 */
export type SandboxFaultSink = (report: {
  tenantId: string;
  productId: string;
  runId: string;
  /** The `owner/repo` of the failed check, or null for the primary target of the run. */
  repositoryFullName: string | null;
  kind: SandboxFault["kind"];
  /** The event message: the fault, the killed processes and the peak. */
  summary: string;
}) => Promise<void>;

/** The sentence a run adds after its fault: the setup run, and the reply that starts a follow-up. */
export const SANDBOX_FAULT_NEXT_STEP =
  "Factoree started a setup run of the repository with this fault as input. Its pull request proposes a sandbox size or service memory caps. Reply to this issue after the merge to start a follow-up run.";

/**
 * Records the event of a sandbox fault, starts the setup run of a run's fault, and gives the
 * message the run ends with. A setup sandbox records the event and starts no other setup run.
 */
export const reportSandboxFault = async (input: {
  recorder: RunEventRecorder | undefined;
  sink: SandboxFaultSink | undefined;
  tenantId: string;
  productId: string;
  repositoryFullName: string | null;
  subject: RunEventSubject;
  stage: string;
  attempt: number;
  step: string;
  /** The words for the check in the sentence, such as "the verify command test". */
  checkName: string;
  command: string;
  exitCode: number | null;
  log: string | null;
  fault: SandboxFault;
  peak: SandboxPeak | null;
  idempotencyKey: string;
}): Promise<string> => {
  const sentence = sandboxFaultSentence({ fault: input.fault, subject: input.checkName, peak: input.peak });
  const isRun = input.subject.runId !== undefined;
  const message = isRun ? `${sentence} ${SANDBOX_FAULT_NEXT_STEP}` : sentence;
  await recordRunEvent(input.recorder, {
    tenantId: input.tenantId,
    subject: input.subject,
    stage: input.stage,
    attempt: input.attempt,
    role: null,
    kind: input.fault.kind,
    message,
    detail: {
      step: input.step,
      command: input.command,
      exitCode: input.exitCode,
      killed: input.fault.kind === "sandbox_out_of_memory" ? input.fault.killed : [],
      kernelLines: input.fault.kernelLines,
      peakMemoryMb: input.peak?.memoryMb ?? null,
      peakDiskMb: input.peak?.diskMb ?? null,
      totalMemoryMb: input.peak?.totalMemoryMb ?? null,
      totalDiskMb: input.peak?.totalDiskMb ?? null,
      log: input.log,
    },
    idempotencyKey: input.idempotencyKey,
  });
  if (input.subject.runId !== undefined && input.sink !== undefined) {
    await input.sink({
      tenantId: input.tenantId,
      productId: input.productId,
      runId: input.subject.runId,
      repositoryFullName: input.repositoryFullName,
      kind: input.fault.kind,
      summary: sentence,
    });
  }
  return message;
};

/**
 * A sandbox fault found inside a pass that cannot record it itself, such as the user validator.
 * The activity that runs the pass records it and ends the run.
 */
export class SandboxFaultError extends Error {
  constructor(
    readonly fault: SandboxFault,
    readonly check: { step: string; checkName: string; command: string; exitCode: number | null; log: string | null },
  ) {
    super(`${check.checkName} stopped on a sandbox fault (${fault.kind})`);
    this.name = "SandboxFaultError";
  }
}

/** Throws a `SandboxFaultError` when the failed check is a sandbox fault, and gives the note otherwise. */
export const throwOnSandboxFault = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  check: FailedCheck & { step: string; checkName: string; command: string },
): Promise<string | null> => {
  const reading = await readSandboxFault(sandbox, ref, check);
  if (reading.fault !== null) {
    throw new SandboxFaultError(reading.fault, {
      step: check.step,
      checkName: check.checkName,
      command: check.command,
      exitCode: check.exitCode,
      log: check.output === "" ? null : check.output,
    });
  }
  return reading.note;
};
