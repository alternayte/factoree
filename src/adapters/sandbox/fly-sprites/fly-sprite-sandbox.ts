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
import { normalizeNetworkPolicy, SandboxError } from "~/domain/runs/sandbox.js";
import type { SpritesGateway } from "./sprites-client.js";
import { toSpritesNetworkPolicy } from "./network-policy.js";

export interface FlySpriteSandboxOptions {
  gateway: SpritesGateway;
  /** The directory inside the sprite that holds every checkout. */
  workspacePath?: string;
  config?: { ramMB?: number; cpus?: number; region?: string };
  /** How many times `applyNetworkPolicy` confirms the new policy. A test lowers it. */
  networkPolicyAttempts?: number;
  /** The delay between two confirmations, in milliseconds. A test sets it to zero. */
  networkPolicyDelayMs?: number;
}

// A Sprite runs a command as the `sprite` user, and the root of the filesystem is not
// writable for it. The home directory is. A workspace at `/workspace` therefore fails at the
// first `mkdir`. See https://docs.sprites.dev/working-with-sprites/.
const DEFAULT_WORKSPACE = "/home/sprite/workspace";

/**
 * The Sprites exec API replaces the whole environment when the request names one, rather than
 * adding to it. A command that carries one variable of its own would otherwise run with no
 * `PATH` at all, and even `mkdir` would not resolve. These two values restore the base
 * environment of the `sprite` user. See https://docs.sprites.dev/working-with-sprites/.
 */
const SPRITE_BASE_ENVIRONMENT: Record<string, string> = {
  // The base `PATH` of the `sprite` user, plus the directory the opencode installer writes to.
  // A repository that installs opencode in its bootstrap command then needs no path of its own.
  PATH:
    "/home/sprite/.opencode/bin:/home/sprite/.local/bin:/.sprite/bin:" +
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/home/sprite",
};



/**
 * How many times `applyNetworkPolicy` confirms that the sandbox can resolve every allowed name,
 * and the delay between two confirmations. Ten attempts at 250 ms bound the wait at 2.5 seconds,
 * well above the 442 ms a measured Sprite needed.
 */
/**
 * The socket of the Sprites API inside a Sprite, the expiry of the task that holds the Sprite
 * active, and the delay between two refreshes of it. A refresh every two minutes against a
 * six-minute expiry survives two lost refreshes.
 */
const SPRITE_API_SOCKET = "/.sprite/api.sock";
const TASK_EXPIRY = "6m";
const TASK_REFRESH_SECONDS = 120;

/**
 * The largest environment Factoree sends inside the exec URL. A measured Sprite accepted a
 * forty-eight kilobyte environment and refused a sixty-four kilobyte one, so this bound leaves
 * room for the command, the working directory, and the rest of the URL.
 */
const MAX_INLINE_ENVIRONMENT_BYTES = 16 * 1024;

/**
 * The largest single environment value a command can carry.
 *
 * Linux caps one argument, and one environment value, at `MAX_ARG_STRLEN`, which is thirty-two
 * pages, or 131072 bytes. The cap belongs to the kernel, so no transport avoids it: a value
 * beyond it fails the `exec` itself, with `Argument list too long` and exit code 126. This bound
 * sits below the cap and names the fault while a caller can still act on it.
 */
const MAX_ENVIRONMENT_VALUE_BYTES = 120 * 1024;

const NETWORK_POLICY_ATTEMPTS = 10;
const NETWORK_POLICY_DELAY_MS = 250;

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
    // See docs/build/decisions.md, DI-2.9.
    supportsExposedServices: true,
  };

  private readonly workspacePath: string;
  /**
   * The environment attached to each sandbox, by sandbox id. It lives in this process only. An
   * activity that reaches a sandbox this process did not create attaches it again.
   */
  private readonly attached = new Map<string, Record<string, string>>();

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
    // The sprite-level environment reaches a shell that inherits it, and the attached copy
    // reaches every exec, which the exec API would otherwise start with a bare environment.
    if (input.environment !== undefined) this.attached.set(name, { ...input.environment });
    // FlySpriteSandbox does not create the workspace directory itself. SandboxManager creates
    // it once, on the caller's side, right after it applies the network policy and before any
    // checkout.
    return { id: name, adapter: this.name, workspacePath: this.workspacePath };
  }

  attachEnvironment(ref: SandboxRef, environment: Record<string, string>): void {
    this.attached.set(ref.id, { ...environment });
  }

  /**
   * The environment of one command. The exec API replaces the whole environment of a call, so
   * every layer must be named here. A `Command.env` value wins over an attached value, and an
   * attached value wins over the base environment.
   */
  private environmentFor(
    ref: SandboxRef,
    env: Record<string, string> | undefined,
    isolated = false,
  ): Record<string, string> {
    const attached = isolated ? {} : (this.attached.get(ref.id) ?? {});
    return { ...SPRITE_BASE_ENVIRONMENT, ...attached, ...(env ?? {}) };
  }

  /**
   * Applies the egress policy, then waits until the sandbox can resolve every allowed name.
   *
   * The Sprites API returns before the DNS allowlist carries the change. A measured Sprite still
   * refused a newly allowed domain 150 ms after the call returned, and resolved it at 442 ms.
   * `SandboxManager` runs the checkout and the bootstrap command immediately afterwards, so a
   * fast preparation reached the network before the policy did, and the failure looked like a
   * wrong allow list rather than a race.
   *
   * The confirmation is bounded. When a name still does not resolve at the end, the method
   * returns anyway: the command that follows then fails with its own message, which names the
   * host and beats a timeout here that names nothing.
   */
  async applyNetworkPolicy(ref: SandboxRef, policy: NetworkPolicy): Promise<void> {
    await this.options.gateway.sprite(ref.id).updateNetworkPolicy(toSpritesNetworkPolicy(policy));

    // A wildcard entry names no host to resolve, so it cannot be confirmed this way.
    const names = normalizeNetworkPolicy(policy).allowedDomains.filter((domain) => !domain.includes("*"));
    if (names.length === 0) return;

    const attempts = this.options.networkPolicyAttempts ?? NETWORK_POLICY_ATTEMPTS;
    const delayMs = this.options.networkPolicyDelayMs ?? NETWORK_POLICY_DELAY_MS;
    const script = names.map((name) => `getent hosts ${shQuote(name)} >/dev/null`).join(" && ");
    const handle = this.options.gateway.sprite(ref.id);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await delay(delayMs);
      try {
        const result = await handle.execFile("sh", ["-c", script], { cwd: "/", env: SPRITE_BASE_ENVIRONMENT });
        if (result.exitCode === 0) return;
      } catch {
        // A failed probe is not a fault of its own. The loop tries again, and the command that
        // follows reports the real problem when the policy never arrives.
      }
    }
  }

  async writeFile(ref: SandboxRef, path: string, content: string): Promise<void> {
    await this.options.gateway.sprite(ref.id).writeFile(path, content);
  }

  async exec(ref: SandboxRef, command: Command): Promise<CommandResult> {
    const startedAt = Date.now();
    try {
      const result = await this.options.gateway.sprite(ref.id).execFile(command.file, command.args, {
        cwd: this.resolveCwd(ref, command.cwd),
        env: this.environmentFor(ref, command.env, command.isolated),
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
   * docs/build/decisions.md, DI-2.10.
   */
  async startProcess(ref: SandboxRef, command: Command): Promise<ProcessRef> {
    const id = `proc-${randomUUID().slice(0, 8)}`;
    const dir = this.procDir(ref, id);
    const handle = this.options.gateway.sprite(ref.id);
    // Create the directory before the wrapper starts, and before this method returns, so a
    // caller that reads or cancels this process immediately after can tell a real identifier
    // apart from one that was never issued.
    await handle.execFile("mkdir", ["-p", dir], { cwd: "/", env: this.environmentFor(ref, undefined) });
    // The exec API of Sprites puts every environment value in the query string of the WebSocket
    // URL, and the server refuses a URL beyond roughly fifty kilobytes. The prompt of an agent
    // travels in the environment, by SDD section 30, and a Reviewer prompt carries the diff and
    // the Validation Contract, so it crossed that limit and the connection failed with a bare
    // TypeError. A measured Sprite accepted 48 kilobytes and refused 64. The environment
    // therefore travels as a file, whose content rides in the body of a request, and the wrapper
    // reads it. A small environment keeps the direct path, which needs no extra call.
    const environment = this.environmentFor(ref, command.env, command.isolated);
    assertEnvironmentValueSizes(environment);
    const environmentFile = `${dir}/env`;
    const inline = byteLengthOf(environment) <= MAX_INLINE_ENVIRONMENT_BYTES;
    if (!inline) await handle.writeFile(environmentFile, environmentScript(environment));

    // One task per process, named after it, so two sessions of one Run hold the Sprite
    // independently and the end of one never releases the hold of the other.
    const wrapper = buildProcessWrapperScript(dir, `factoree-${id}`, inline ? null : environmentFile);
    await handle.startDetached("sh", ["-c", wrapper, "sh", command.file, ...command.args], {
      cwd: this.resolveCwd(ref, command.cwd),
      env: inline ? environment : SPRITE_BASE_ENVIRONMENT,
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
   * docs/build/decisions.md, DI-2.10.
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
      await handle.execFile("sh", ["-c", `: > ${shQuote(cancelFile)}`], { cwd: "/", env: SPRITE_BASE_ENVIRONMENT });

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
      await handle.execFile("sh", ["-c", killScript], { cwd: ref.workspacePath, env: SPRITE_BASE_ENVIRONMENT });
    } catch {
      // Cancellation is idempotent. A process that has already gone is cancelled.
    }
  }

  async checkpoint(ref: SandboxRef, name: string): Promise<CheckpointRef> {
    const created = await this.options.gateway.sprite(ref.id).createCheckpoint(name);
    return { id: created.id, name };
  }

  // H-2 and DI-14.17. A live probe proved that a service declaring `httpPort` routes the sprite
  // URL to that port. The URL is the base URL of the preview for the User Validator.
  async exposeService(ref: SandboxRef, port: number): Promise<ServiceRef> {
    try {
      const url = await this.options.gateway.sprite(ref.id).publishPort(port);
      return { port, url: url.replace(/\/+$/, "") };
    } catch (error) {
      throw new SandboxError(`fly-sprites could not publish port ${port}: ${String(error)}`, this.name);
    }
  }

  async destroy(ref: SandboxRef): Promise<void> {
    this.attached.delete(ref.id);
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
    const result = await handle.execFile("sh", ["-c", script], { cwd: "/", env: SPRITE_BASE_ENVIRONMENT });
    return result.stdout.trim() === "1";
  }

  private async readFileText(handle: ReturnType<SpritesGateway["sprite"]>, path: string): Promise<string> {
    const script = `if [ -f ${shQuote(path)} ]; then cat ${shQuote(path)}; fi`;
    const result = await handle.execFile("sh", ["-c", script], { cwd: "/", env: SPRITE_BASE_ENVIRONMENT });
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
/**
 * Rejects an environment value the kernel cannot carry, and names the value.
 *
 * The prompt of an agent travels in the environment, by SDD section 30, so a very large prompt
 * reaches this bound. The message says which value is too large, because the alternative is
 * `Argument list too long` from a shell, which names nothing.
 */
const assertEnvironmentValueSizes = (environment: Record<string, string>): void => {
  for (const [key, value] of Object.entries(environment)) {
    const size = Buffer.byteLength(value, "utf8");
    if (size > MAX_ENVIRONMENT_VALUE_BYTES) {
      throw new SandboxError(
        `the environment value "${key}" is ${size} bytes, and Linux carries at most ` +
          `${MAX_ENVIRONMENT_VALUE_BYTES} bytes in one value. The command would fail with ` +
          '"Argument list too long".',
        "fly-sprites",
      );
    }
  }
};

/** The byte length of an environment, as the URL would carry it. */
const byteLengthOf = (environment: Record<string, string>): number =>
  Object.entries(environment).reduce(
    (total, [key, value]) => total + Buffer.byteLength(`${key}=${value}`, "utf8") + 5,
    0,
  );

/** A shell script that exports one environment. Every value is quoted, so no value is re-read. */
const environmentScript = (environment: Record<string, string>): string =>
  Object.entries(environment)
    .map(([key, value]) => `export ${key}=${shQuote(value)}`)
    .join("\n");

const buildProcessWrapperScript = (dir: string, taskName: string, environmentFile: string | null): string => {
  const pidFile = shQuote(posix.join(dir, "pid"));
  const outFile = shQuote(posix.join(dir, "out"));
  const errFile = shQuote(posix.join(dir, "err"));
  const exitFile = shQuote(posix.join(dir, "exit"));
  const cancelFile = shQuote(posix.join(dir, "cancel"));
  const task = shQuote(taskName);
  const api = `curl -s -o /dev/null --unix-socket ${SPRITE_API_SOCKET} -H 'Content-Type: application/json'`;
  return [
    "set -m",
    `mkdir -p ${shQuote(dir)}`,
    // A large environment arrives as a file, because the exec URL cannot carry it.
    ...(environmentFile === null ? [] : [`. ${shQuote(environmentFile)}`]),
    `if [ -e ${cancelFile} ]; then echo 143 >${exitFile}; exit 0; fi`,
    // SDD section 32. A Sprite pauses when it looks idle, and a pause drops every open TCP
    // connection, even a warm one. An agent waits on the connection that carries the model
    // answer, so a pause leaves it waiting for a reply that can never arrive. A task holds the
    // Sprite active while the agent works. A failure to create it never fails the Run: the agent
    // still runs, and the idle deadline of the runner still ends a session that stalls.
    `${api} -X POST http://sprite/v1/tasks -d '{"name":"${taskName}","expire":"${TASK_EXPIRY}"}' || true`,
    `"$@" >${outFile} 2>${errFile} &`,
    "child=$!",
    `echo "$child" >${pidFile}`,
    // The refresh runs at a third of the expiry, so two lost refreshes still leave the task alive.
    "( while kill -0 \"$child\" 2>/dev/null; do",
    `  sleep ${TASK_REFRESH_SECONDS}`,
    `  ${api} -X PUT http://sprite/v1/tasks/${taskName} -d '{"expire":"${TASK_EXPIRY}"}' || true`,
    "done ) &",
    "keeper=$!",
    'wait "$child"',
    "ec=$?",
    'kill "$keeper" 2>/dev/null || true',
    // The hold is released as soon as the agent stops, so the Sprite can pause again and the
    // billing of an idle Sprite stops with it.
    `${api} -X DELETE http://sprite/v1/tasks/${task} || true`,
    `echo "$ec" >${exitFile}`,
  ].join("\n");
};
