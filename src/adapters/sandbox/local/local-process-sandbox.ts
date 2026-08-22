import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
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

/**
 * A Sandbox that runs commands as child processes in a per-Run directory.
 *
 * It gives the test suite and local development a sandbox that needs no credentials. It cannot
 * enforce an egress policy. It reports `enforcesNetworkPolicy: false`. `SandboxManager` refuses
 * to run an agent in it unless the caller opts in. Production uses `FlySpriteSandbox`.
 */
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
      // The child process inherits the full host environment. This choice is deliberate for a
      // local development and test adapter. The production adapter does not do this.
      const child = spawn(command.file, command.args, {
        cwd: this.resolveCwd(ref, command.cwd),
        env: { ...process.env, ...command.env },
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
    // The child process inherits the full host environment. This choice is deliberate for a
    // local development and test adapter. The production adapter does not do this.
    const child = spawn(command.file, command.args, {
      cwd: this.resolveCwd(ref, command.cwd),
      env: { ...process.env, ...command.env },
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
    await rm(join(this.options.rootDirectory, ref.id), { recursive: true, force: true });
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
