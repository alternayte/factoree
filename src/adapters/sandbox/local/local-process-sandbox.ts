import { spawn } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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

export interface LocalProcessSandboxOptions {
  /** Every sandbox becomes one directory below this path. */
  rootDirectory: string;
}

interface RunningProcess {
  stdout: string;
  stderr: string;
  running: boolean;
  exitCode: number | null;
  kill: () => void;
}

/** True when the platform reports that the path is already gone. */
const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

/**
 * Restores owner write permission across one directory tree, so removal can proceed.
 *
 * `checkoutRepositories` makes every reference checkout read-only, because SDD section 29 denies
 * an agent writing one. That state is normal for every Run that has a reference repository, and
 * the adapter's own cleanup must cope with it. A missing path is not an error, because
 * destruction is idempotent. A symbolic link keeps its own mode, because the target belongs to
 * another owner.
 */
const restoreWritePermission = async (path: string): Promise<void> => {
  let targets: string[];
  try {
    const entries = await readdir(path, { recursive: true, withFileTypes: true });
    targets = [path, ...entries.map((entry) => join(entry.parentPath, entry.name))];
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  for (const target of targets) {
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) continue;
      await chmod(target, info.mode | 0o200);
    } catch (error) {
      // A path that vanished between the listing and this call needs no permission change.
      if (!isMissing(error)) throw error;
    }
  }
};

/**
 * A Sandbox that runs commands as child processes in a per-Run directory.
 *
 * It gives the test suite and local development a sandbox that needs no credentials. It cannot
 * enforce an egress policy. It reports `enforcesNetworkPolicy: false`. `SandboxManager` refuses
 * to run an agent in it unless the caller opts in. Production uses `FlySpriteSandbox`.
 */
/**
 * The host variables one child process may read.
 *
 * SDD section 30 forbids the Implementer receiving a Factoree admin credential, a Linear token,
 * or a GitHub write credential. The worker holds all three in its own environment, so the child
 * receives an allow list and nothing else. A deny list is wrong by default, and one forgotten
 * name leaks an admin credential. `FlySpriteSandbox` already passes the command environment
 * alone, so the two adapters now agree.
 *
 * Each entry earns its place:
 * `PATH` finds `git`, `sh`, and `node`. `HOME` gives git and npm a place for a configuration
 * file and a cache. `TMPDIR`, `TMP`, and `TEMP` name the temporary directory a tool writes to.
 * `LANG`, `LC_ALL`, and `TZ` fix the text encoding and the time of a tool that formats output.
 * `TERM` stops a tool that reads the terminal type from failing. `SHELL` answers a tool that
 * asks for the login shell. `SYSTEMROOT` is mandatory for a process on Windows.
 */
const INHERITED_ENVIRONMENT_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "SHELL",
  "SYSTEMROOT",
] as const;

/** Builds the environment of one child process from the allow list and the command. */
const buildChildEnvironment = (commandEnvironment?: Record<string, string>): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENVIRONMENT_NAMES) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...commandEnvironment };
};

export class LocalProcessSandbox implements Sandbox {
  readonly name = "local";
  readonly capabilities: SandboxCapabilities = {
    enforcesNetworkPolicy: false,
    supportsCheckpoints: true,
    supportsExposedServices: false,
  };

  private readonly live = new Set<string>();
  private readonly processes = new Map<string, RunningProcess>();

  constructor(private readonly options: LocalProcessSandboxOptions) {}

  async create(input: SandboxCreateInput): Promise<SandboxRef> {
    const id = `local-${input.runId}-${randomUUID().slice(0, 8)}`;
    const workspacePath = join(this.options.rootDirectory, id, "workspace");
    await mkdir(workspacePath, { recursive: true });
    this.live.add(id);
    return { id, adapter: this.name, workspacePath };
  }

  applyNetworkPolicy(ref: SandboxRef, policy: NetworkPolicy): Promise<void> {
    // This adapter records nothing. `SandboxManager` never lets an agent run here in production.
    // The reason is that `capabilities.enforcesNetworkPolicy` is false.
    void policy;
    this.assertLive(ref);
    return Promise.resolve();
  }

  async exec(ref: SandboxRef, command: Command): Promise<CommandResult> {
    this.assertLive(ref);
    const startedAt = Date.now();
    return await new Promise<CommandResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn(command.file, command.args, {
        cwd: this.resolveCwd(ref, command.cwd),
        env: buildChildEnvironment(command.env),
      });
      const timer =
        command.timeoutMs === undefined
          ? null
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, command.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      const finish = (exitCode: number): void => {
        if (timer !== null) clearTimeout(timer);
        resolve({ exitCode, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
      };
      child.on("error", (error) => {
        stderr += error.message;
        finish(127);
      });
      child.on("close", (code, signal) => finish(code ?? (signal === null ? 1 : 128)));
    });
  }

  startProcess(ref: SandboxRef, command: Command): Promise<ProcessRef> {
    this.assertLive(ref);
    // This method ignores command.timeoutMs. The caller must enforce its own deadline and stop
    // the process with cancelProcess.
    const id = `process-${randomUUID().slice(0, 8)}`;
    const child = spawn(command.file, command.args, {
      cwd: this.resolveCwd(ref, command.cwd),
      env: buildChildEnvironment(command.env),
    });
    const record: RunningProcess = {
      stdout: "",
      stderr: "",
      running: true,
      exitCode: null,
      kill: () => child.kill("SIGKILL"),
    };
    child.stdout.on("data", (chunk: Buffer) => (record.stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (record.stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      record.stderr += error.message;
      record.running = false;
      record.exitCode = 127;
    });
    child.on("close", (code, signal) => {
      record.running = false;
      record.exitCode = code ?? (signal === null ? 1 : 137);
    });
    this.processes.set(id, record);
    return Promise.resolve({ id });
  }

  readProcess(ref: SandboxRef, process: ProcessRef): Promise<ProcessSnapshot> {
    this.assertLive(ref);
    const record = this.processes.get(process.id);
    if (record === undefined) throw new SandboxError(`unknown process ${process.id}`, this.name);
    return Promise.resolve({
      running: record.running,
      exitCode: record.exitCode,
      stdout: record.stdout,
      stderr: record.stderr,
    });
  }

  cancelProcess(_ref: SandboxRef, process: ProcessRef): Promise<void> {
    const record = this.processes.get(process.id);
    // A finished process or an unknown process is not an error. Cancellation is idempotent.
    if (record !== undefined && record.running) record.kill();
    return Promise.resolve();
  }

  async checkpoint(ref: SandboxRef, name: string): Promise<CheckpointRef> {
    this.assertLive(ref);
    const id = `${name}-${randomUUID().slice(0, 8)}`;
    const target = join(this.options.rootDirectory, ref.id, "checkpoints", id);
    await cp(ref.workspacePath, target, { recursive: true });
    return { id, name };
  }

  exposeService(ref: SandboxRef, port: number): Promise<ServiceRef> {
    this.assertLive(ref);
    // A local process already listens on the host loopback interface.
    return Promise.resolve({ port, url: `http://127.0.0.1:${port}` });
  }

  async destroy(ref: SandboxRef): Promise<void> {
    // An unknown sandbox is not an error to destroy. Destruction is idempotent.
    this.live.delete(ref.id);
    const path = join(this.options.rootDirectory, ref.id);
    // Every reference checkout is read-only, and the baseline checkpoint holds a read-only copy
    // of it. The owner must hold write permission on a directory before the platform removes an
    // entry inside it, so removal alone fails on an ordinary Run that has a reference
    // repository. This step restores that permission first.
    //
    // A failure of the permission repair must not stop the removal. This method already dropped
    // the sandbox from the live set, so no later call can reach the directory. A removal that
    // can still succeed is better than one that never runs. The removal itself decides the
    // outcome: it throws when the directory stays behind.
    await restoreWritePermission(path).catch(() => undefined);
    await rm(path, { recursive: true, force: true });
  }

  private resolveCwd(ref: SandboxRef, cwd: string | undefined): string {
    if (cwd === undefined) return ref.workspacePath;
    return isAbsolute(cwd) ? cwd : join(ref.workspacePath, cwd);
  }

  private assertLive(ref: SandboxRef): void {
    if (!this.live.has(ref.id)) throw new SandboxError(`sandbox ${ref.id} is destroyed`, this.name);
  }
}

/**
 * Creates one LocalProcessSandbox rooted in a fresh temporary directory, together with a
 * dispose function that removes the directory. Callers that do not manage a root directory
 * of their own can use this function directly.
 */
export const createLocalProcessSandbox = async (): Promise<{
  sandbox: LocalProcessSandbox;
  dispose: () => Promise<void>;
}> => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "factoree-sandbox-"));
  const sandbox = new LocalProcessSandbox({ rootDirectory });
  return { sandbox, dispose: async () => rm(rootDirectory, { recursive: true, force: true }) };
};
