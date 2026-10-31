import type { ProcessRef, Sandbox, SandboxRef } from "./sandbox.js";
import type { PreviewConfig } from "./project-runtime-config.js";
import type { Redactor } from "~/telemetry/redaction.js";

/**
 * SDD section 37, steps 1 to 3. Starts the repository preview inside the sandbox, waits until
 * it answers, and exposes its port for a client outside the sandbox. Task 3 adds the browser
 * and HTTP assertions of steps 4 and 5.
 */

/** The interval between two readiness polls. SDD section 37. */
const POLL_INTERVAL_MS = 250;

/** Reports the HTTP status of one readiness request, or null when nothing answered. */
export type ReadinessProbe = (url: string) => Promise<{ status: number } | null>;

export interface PreviewHandle {
  process: ProcessRef;
  /** The URL a client outside the sandbox uses. SDD section 37 step 3. */
  baseUrl: string;
  port: number;
  readyUrl: string;
  startedAt: string;
  /** The redacted output the preview produced while it started. */
  startupLog: string;
}

export type PreviewFailureReason = "not_ready" | "exited" | "no_port" | "expose_failed";

export class PreviewStartError extends Error {
  constructor(message: string, readonly reason: PreviewFailureReason, readonly log: string) {
    super(message);
    this.name = "PreviewStartError";
  }
}

export interface StartPreviewInput {
  sandbox: Sandbox;
  ref: SandboxRef;
  /** The primary worktree. The preview command runs from there. */
  workingDirectory: string;
  preview: PreviewConfig;
  environment: Record<string, string>;
  probe: ReadinessProbe;
  redactor: Redactor;
  /** Injected so a unit test needs no real delay. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Builds the redacted output of a process for a failure the operator must read. */
const buildLog = (redactor: Redactor, stdout: string, stderr: string): string =>
  redactor.redactText(`--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);

/** Ready means the probe returned a status from 200 to 399. SDD section 37 rule 5. */
const isReady = (result: { status: number } | null): boolean =>
  result !== null && result.status >= 200 && result.status < 400;

export const startPreview = async (input: StartPreviewInput): Promise<PreviewHandle> => {
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? (() => Date.now());

  // Rule 1. Factoree cannot expose a port it cannot name, so the readiness URL must carry an
  // explicit port.
  const port = Number(new URL(input.preview.readyUrl).port);
  if (!Number.isFinite(port) || port === 0 || Number.isNaN(port)) {
    throw new PreviewStartError(
      `The preview readiness URL "${input.preview.readyUrl}" carries no explicit port. ` +
        "State an explicit port in preview.readyUrl.",
      "no_port",
      "",
    );
  }

  // The preview port belongs to Factoree's preview. An agent can leave a server of its own on
  // it, and on the FAC-44 run one made `next start` fail with EADDRINUSE. The stray server would
  // also answer the readiness poll for a change Factoree did not start.
  await input.sandbox.exec(input.ref, {
    file: "sh",
    args: [
      "-c",
      `for pid in $(ss -ltnpH "sport = :${port}" | grep -o "pid=[0-9]*" | cut -d= -f2 | sort -u); do kill "$pid"; done; true`,
    ],
    cwd: "/",
  });

  const startedAt = new Date(now()).toISOString();
  // Rule 2. `startProcess` ignores `Command.timeoutMs`, so this function owns the deadline below.
  const processRef = await input.sandbox.startProcess(input.ref, {
    file: "sh",
    args: ["-c", input.preview.command],
    cwd: input.workingDirectory,
    env: input.environment,
  });

  const pollUntilReady = async (): Promise<PreviewHandle> => {
    // Rule 7. The exposed URL is the URL a client outside the sandbox uses. The readiness URL
    // names an address inside the sandbox, and on the worker `localhost` is the worker itself:
    // the FAC-46 run polled the local Factoree API for the whole timeout. So the poll requests
    // the readiness path at the exposed URL. Exposure needs no running server. A sandbox adapter
    // that cannot expose a service fails here the same honest way every preview failure does.
    let service;
    try {
      service = await input.sandbox.exposeService(input.ref, port);
    } catch (error) {
      throw new PreviewStartError(
        `The sandbox could not expose the preview on port ${String(port)}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        "expose_failed",
        "",
      );
    }
    const ready = new URL(input.preview.readyUrl);
    const probeUrl = new URL(`${ready.pathname}${ready.search}`, service.url).toString();

    // Rule 3. The deadline is measured from the first poll, not from the process start.
    const deadline = now() + input.preview.timeoutSeconds * 1000;

    for (;;) {
      // Rule 4. A process that has exited is polled no further; a dead server never turns ready.
      const snapshot = await input.sandbox.readProcess(input.ref, processRef);
      if (!snapshot.running) {
        throw new PreviewStartError(
          `The preview command "${input.preview.command}" exited before it answered.`,
          "exited",
          buildLog(input.redactor, snapshot.stdout, snapshot.stderr),
        );
      }

      // Rule 5. Any status outside 200 to 399, and a null answer, means keep polling.
      const result = await input.probe(probeUrl);
      if (isReady(result)) {
        return {
          process: processRef,
          baseUrl: service.url,
          port,
          readyUrl: input.preview.readyUrl,
          startedAt,
          startupLog: buildLog(input.redactor, snapshot.stdout, snapshot.stderr),
        };
      }

      // Rule 6. The deadline passes with the process still alive but never ready.
      if (now() >= deadline) {
        throw new PreviewStartError(
          `The preview command "${input.preview.command}" did not answer within ` +
            `${input.preview.timeoutSeconds} seconds.`,
          "not_ready",
          buildLog(input.redactor, snapshot.stdout, snapshot.stderr),
        );
      }

      await sleep(POLL_INTERVAL_MS);
    }
  };

  // Rule 10. The process is already running. Every failure below must cancel it, or the
  // preview leaks until the sandbox reaper removes the whole sandbox. A failure to cancel
  // must not replace the original error, because the operator needs the original error.
  try {
    return await pollUntilReady();
  } catch (error) {
    try {
      await input.sandbox.cancelProcess(input.ref, processRef);
    } catch {
      // The original error stands.
    }
    throw error;
  }
};

/**
 * Rule 9. Stops the preview process. The caller runs this in a `finally`, so it must not throw
 * when the process already exited; `Sandbox.cancelProcess` is idempotent by contract.
 */
export const stopPreview = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  handle: PreviewHandle,
): Promise<void> => {
  await sandbox.cancelProcess(ref, handle.process);
};
