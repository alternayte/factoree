import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type {
  CheckpointRef,
  Command,
  CommandResult,
  NetworkPolicy,
  ProcessRef,
  ProcessSnapshot,
  Sandbox,
  SandboxCapabilities,
  SandboxCreateInput,
  SandboxRef,
  ServiceRef,
} from "~/domain/runs/sandbox.js";
import { SandboxError } from "~/domain/runs/sandbox.js";
import type { SpritesGateway } from "./sprites-client.js";
import { toSpritesNetworkPolicy } from "./network-policy.js";

export interface FlySpriteSandboxOptions {
  gateway: SpritesGateway;
  /** The directory inside the sprite that holds every checkout. */
  workspacePath?: string;
  config?: { ramMB?: number; cpus?: number; region?: string };
}

const DEFAULT_WORKSPACE = "/workspace";

/** The number of times `cancelProcess` rereads the pid file before it gives up. */
const CANCEL_PID_ATTEMPTS = 5;
/** The delay between each of those rereads, in milliseconds. */
const CANCEL_PID_RETRY_DELAY_MS = 40;

/** SDD section 31. The required Sandbox implementation. */
export class FlySpriteSandbox implements Sandbox {
  readonly name = "fly-sprites";
  readonly capabilities: SandboxCapabilities = {
    enforcesNetworkPolicy: true,
    supportsCheckpoints: true,
    // The Fly Sprites SDK version 0.2.0 has no documented API that publishes a port to a
    // reachable URL. `exposeService` throws a clear error instead of a claim of success.
    // See docs/build/evidence/phase-02-sprites-sdk.md, item 7.
    supportsExposedServices: false,
  };

  private readonly workspacePath: string;

  constructor(private readonly options: FlySpriteSandboxOptions) {
    this.workspacePath = options.workspacePath ?? DEFAULT_WORKSPACE;
  }

  async create(input: SandboxCreateInput): Promise<SandboxRef> {
    // SDD section 32: one Run uses one unique mutable Sprite. The random suffix keeps the name
    // unique even when a Run is retried after a create that partly succeeded.
    const name = `factoree-${input.runId}-${randomUUID().slice(0, 8)}`.toLowerCase();
    await this.options.gateway.createSprite(name, {
      ...(this.options.config?.ramMB === undefined ? {} : { ramMB: this.options.config.ramMB }),
      ...(this.options.config?.cpus === undefined ? {} : { cpus: this.options.config.cpus }),
      ...(this.options.config?.region === undefined ? {} : { region: this.options.config.region }),
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    });
    // FlySpriteSandbox does not create the workspace directory itself. SandboxManager creates
    // it once, on the caller's side, right after it applies the network policy and before any
    // checkout.
    return { id: name, adapter: this.name, workspacePath: this.workspacePath };
  }

  async applyNetworkPolicy(ref: SandboxRef, policy: NetworkPolicy): Promise<void> {
    await this.options.gateway.sprite(ref.id).updateNetworkPolicy(toSpritesNetworkPolicy(policy));
  }

  async exec(ref: SandboxRef, command: Command): Promise<CommandResult> {
    const startedAt = Date.now();
    try {
      const result = await this.options.gateway.sprite(ref.id).execFile(command.file, command.args, {
        cwd: this.resolveCwd(ref, command.cwd),
        env: command.env ?? {},
        ...(command.timeoutMs === undefined ? {} : { timeout: command.timeoutMs }),
      });
      return { ...result, timedOut: false, durationMs: Date.now() - startedAt };
    } catch (error) {
      // A non-zero exit code is a result, not a fault. Only an infrastructure fault throws.
      const failure = asExecFailure(error);
      if (failure === null) throw error;
      return { ...failure, durationMs: Date.now() - startedAt };
    }
  }

  /**
   * The Fly Sprites SDK version 0.2.0 reports no exit code and no accumulated output for a
   * finished detached session. `startProcess` works around this gap with a shell wrapper. It
   * first creates the process directory itself, with a blocking `exec` call, so that
   * directory's presence becomes a reliable signal that this identifier was truly issued. It
   * then starts a wrapper that writes the remote shell's process group leader to a `pid` file,
   * sends standard output to an `out` file and standard error to an `err` file, and writes the
   * numeric exit code to an `exit` file last, so that file's presence is the signal that the
   * process finished. `readProcess` and `cancelProcess` read these files back with `exec`. See
   * docs/build/evidence/phase-02-sprites-sdk.md, items 4 and 5.
   */
  async startProcess(ref: SandboxRef, command: Command): Promise<ProcessRef> {
    const id = `proc-${randomUUID().slice(0, 8)}`;
    const dir = this.procDir(ref, id);
    const handle = this.options.gateway.sprite(ref.id);
    // Create the directory before the wrapper starts, and before this method returns, so a
    // caller that reads or cancels this process immediately after can tell a real identifier
    // apart from one that was never issued.
    await handle.execFile("mkdir", ["-p", dir], { cwd: "/", env: {} });
    const wrapper = buildProcessWrapperScript(dir);
    await handle.startDetached("sh", ["-c", wrapper, "sh", command.file, ...command.args], {
      cwd: this.resolveCwd(ref, command.cwd),
      env: command.env ?? {},
    });
    return { id };
  }

  async readProcess(ref: SandboxRef, process: ProcessRef): Promise<ProcessSnapshot> {
    const dir = this.procDir(ref, process.id);
    const handle = this.options.gateway.sprite(ref.id);
    if (!(await this.pathExists(handle, dir))) {
      // An identifier with no process directory was never issued by this adapter. A caller
      // that polls such an identifier otherwise waits forever for an `exit` file that never
      // appears.
      throw new SandboxError(`fly-sprites has no process ${process.id} in sandbox ${ref.id}`, this.name);
    }
    const readFileOrEmpty = (path: string): Promise<string> => this.readFileText(handle, path).catch(() => "");

    const exitText = await readFileOrEmpty(posix.join(dir, "exit"));
    const trimmedExit = exitText.trim();
    const parsedExit = trimmedExit === "" ? null : Number.parseInt(trimmedExit, 10);
    const exitCode = parsedExit !== null && !Number.isNaN(parsedExit) ? parsedExit : null;
    const stdout = await readFileOrEmpty(posix.join(dir, "out"));
    const stderr = await readFileOrEmpty(posix.join(dir, "err"));
    return {
      running: exitCode === null,
      exitCode,
      stdout,
      stderr,
    };
  }

  /**
   * A cancel issued in the first moments after `startProcess` returns can arrive before the
   * wrapper has backgrounded the real command and written its `pid` file. SDD section 50
   * requires a stop signal to terminate the active process even then, so this method closes
   * that window with a cancel marker the wrapper checks before it launches anything, and
   * narrows the remaining gap, between the wrapper's marker check and its `pid` write, with a
   * bounded reread of the `pid` file. That remaining gap is not eliminated: on a sprite slow
   * enough to miss every reread, the process still starts. See
   * docs/build/evidence/phase-02-sprites-sdk.md, item 4.
   */
  async cancelProcess(ref: SandboxRef, process: ProcessRef): Promise<void> {
    const dir = this.procDir(ref, process.id);
    const handle = this.options.gateway.sprite(ref.id);
    try {
      if (!(await this.pathExists(handle, dir))) {
        // An identifier that was never issued, or a sandbox that is already gone, leaves
        // nothing to cancel.
        return;
      }
      // Close the window in which the wrapper has not yet checked for a cancel marker. A
      // wrapper that finds this file before it backgrounds the real command never starts it.
      const cancelFile = posix.join(dir, "cancel");
      await handle.execFile("sh", ["-c", `: > ${shQuote(cancelFile)}`], { cwd: "/", env: {} });

      const pidFile = posix.join(dir, "pid");
      let pidText = "";
      for (let attempt = 0; attempt < CANCEL_PID_ATTEMPTS && pidText === ""; attempt += 1) {
        if (attempt > 0) await delay(CANCEL_PID_RETRY_DELAY_MS);
        pidText = (await this.readFileText(handle, pidFile)).trim();
      }
      // The wrapper checked the marker before this call wrote it, then never started the
      // real command. There is nothing left to terminate.
      if (!/^[0-9]+$/.test(pidText)) return;

      const killScript = `kill -TERM -${pidText} 2>/dev/null || kill -TERM ${pidText} 2>/dev/null; true`;
      await handle.execFile("sh", ["-c", killScript], { cwd: ref.workspacePath, env: {} });
    } catch {
      // Cancellation is idempotent. A process that has already gone is cancelled.
    }
  }

  async checkpoint(ref: SandboxRef, name: string): Promise<CheckpointRef> {
    const created = await this.options.gateway.sprite(ref.id).createCheckpoint(name);
    return { id: created.id, name };
  }

  // The Fly Sprites SDK version 0.2.0 has no documented API that publishes a port to a
  // reachable URL. See docs/build/evidence/phase-02-sprites-sdk.md, item 7. This method
  // throws rather than pretend, so it stays honest with `capabilities.supportsExposedServices`
  // regardless of which gateway implementation backs it.
  exposeService(_ref: SandboxRef, port: number): Promise<ServiceRef> {
    return Promise.reject(
      new SandboxError(
        `fly-sprites has no documented API that publishes port ${port} to a reachable URL`,
        this.name,
      ),
    );
  }

  async destroy(ref: SandboxRef): Promise<void> {
    try {
      await this.options.gateway.sprite(ref.id).delete();
    } catch {
      // Destruction is idempotent. A sprite that has already gone is destroyed.
    }
  }

  private procDir(ref: SandboxRef, id: string): string {
    return posix.join(ref.workspacePath, ".factoree", "proc", id);
  }

  private async pathExists(handle: ReturnType<SpritesGateway["sprite"]>, path: string): Promise<boolean> {
    const script = `if [ -e ${shQuote(path)} ]; then echo 1; fi`;
    const result = await handle.execFile("sh", ["-c", script], { cwd: "/", env: {} });
    return result.stdout.trim() === "1";
  }

  private async readFileText(handle: ReturnType<SpritesGateway["sprite"]>, path: string): Promise<string> {
    const script = `if [ -f ${shQuote(path)} ]; then cat ${shQuote(path)}; fi`;
    const result = await handle.execFile("sh", ["-c", script], { cwd: "/", env: {} });
    return result.stdout;
  }

  private resolveCwd(ref: SandboxRef, cwd: string | undefined): string {
    if (cwd === undefined) return ref.workspacePath;
    return posix.isAbsolute(cwd) ? cwd : posix.join(ref.workspacePath, cwd);
  }
}

interface ExecFailure {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const asExecFailure = (error: unknown): ExecFailure | null => {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { exitCode?: unknown; stdout?: unknown; stderr?: unknown; name?: unknown };
  if (typeof candidate.exitCode !== "number") {
    // An abort or a timeout carries no exit code. It is still a command outcome, not a fault.
    if (candidate.name === "AbortError" || candidate.name === "TimeoutError") {
      return { exitCode: 124, stdout: "", stderr: "the command reached its timeout", timedOut: true };
    }
    return null;
  }
  return {
    exitCode: candidate.exitCode,
    stdout: typeof candidate.stdout === "string" ? candidate.stdout : "",
    stderr: typeof candidate.stderr === "string" ? candidate.stderr : "",
    timedOut: false,
  };
};

/** Quotes one value for safe use inside a POSIX shell single-quoted string. */
const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds the wrapper script that `startProcess` runs under `sh -c`. The script receives the
 * real command as positional parameters, through `"$@"`, rather than as text folded into the
 * script. This keeps the caller's file and arguments intact, and the shell never splits them
 * apart again. It checks the cancel marker before it backgrounds the real command, so a cancel
 * that wins the race stops the command from starting at all.
 */
const buildProcessWrapperScript = (dir: string): string => {
  const pidFile = shQuote(posix.join(dir, "pid"));
  const outFile = shQuote(posix.join(dir, "out"));
  const errFile = shQuote(posix.join(dir, "err"));
  const exitFile = shQuote(posix.join(dir, "exit"));
  const cancelFile = shQuote(posix.join(dir, "cancel"));
  return [
    "set -m",
    `mkdir -p ${shQuote(dir)}`,
    `if [ -e ${cancelFile} ]; then echo 143 >${exitFile}; exit 0; fi`,
    `"$@" >${outFile} 2>${errFile} &`,
    "child=$!",
    `echo "$child" >${pidFile}`,
    'wait "$child"',
    "ec=$?",
    `echo "$ec" >${exitFile}`,
  ].join("\n");
};
