import { DOCKER_ENVIRONMENT } from "~/domain/runs/services.js";
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
  WarmSnapshots,
} from "~/domain/runs/sandbox.js";
import { normalizeNetworkPolicy, SandboxError } from "~/domain/runs/sandbox.js";
import { DEFAULT_KILN_SANDBOX_SIZE, type KilnSandboxSize } from "~/domain/settings/install-settings.js";
import { KILN_RUNNER_BIN, templateName } from "../kiln/kiln-sandbox.js";
import type { E2BGateway } from "./e2b-client.js";

export interface E2BSandboxOptions {
  gateway: E2BGateway;
  /** The Factoree sandbox image, `<name>@sha256:<hex>`. One template serves one digest and one size. */
  image: string;
  /** docs/specs/kiln-sandbox-size.md. The size of every sandbox. Absent means the default. */
  size?: KilnSandboxSize;
  /** The registry login for a private image. It reaches the template build only. */
  registryCredential?: { username: string; token: string };
  /** The delay between two reads of the pid file in `cancelProcess`. A test sets it to zero. */
  cancelRetryMs?: number;
  /** The clock of the keep-alive. A test replaces it. */
  now?: () => number;
}

// sandbox/Dockerfile creates this user. Every command and file write runs as it, and the runner
// CLIs in /opt/factoree/bin stay root-owned (B-2).
const SANDBOX_USER = "agent";
/** Only the device chmod after a create runs as root (DI-21.29). */
const ROOT_USER = "root";
const DEVICE_CHMOD_TIMEOUT_MS = 30_000;
const DEFAULT_WORKSPACE = "/home/agent/workspace";
/** Outside the workspace, so no checkout and no diff ever holds a process file. */
const PROCESS_ROOT = "/home/agent/.factoree/proc";

/**
 * E2B runs a command under a login shell, and `/etc/profile` resets `PATH`. The command string
 * sets this `PATH` again before it starts the command. The runner directory comes first, so a CLI
 * the bootstrap installs in a user directory cannot shadow it.
 */
const E2B_PATH = `${KILN_RUNNER_BIN}:/home/agent/.local/share/mise/shims:/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

/**
 * docs/specs/e2b-sandbox-provider.md. E2B pauses a sandbox when its timeout ends. Each call moves
 * the timeout, so only a sandbox with no call for this long pauses. The runner reads its process
 * each second, so a work sprite never pauses while an agent runs.
 */
const IDLE_MS = 10 * 60_000;
/** The keep-alive is one more request. It runs at most once a minute per sandbox. */
const KEEP_ALIVE_EVERY_MS = 60_000;

const CANCEL_PID_ATTEMPTS = 10;
const CANCEL_RETRY_MS = 100;

/** docs/specs/e2b-sandbox-provider.md. Runs the work sprite and the check sprites on E2B. */
export class E2BSandbox implements Sandbox {
  readonly name = "e2b";
  readonly capabilities: SandboxCapabilities = {
    // `updateNetwork` swaps the rules at the E2B proxy, outside the guest.
    enforcesNetworkPolicy: true,
    // Warm snapshots use `warmSnapshots`. A snapshot per run would hold storage until a delete.
    supportsCheckpoints: false,
    supportsExposedServices: true,
    supportsCustomImage: true,
    supportsDocker: true,
  };
  readonly image: string;
  readonly warmSnapshots: WarmSnapshots;

  private readonly template: string;
  private readonly size: KilnSandboxSize;
  private templateReady: Promise<void> | null = null;
  private readonly attached = new Map<string, Record<string, string>>();
  private readonly lastKeepAlive = new Map<string, number>();

  constructor(private readonly options: E2BSandboxOptions) {
    this.image = options.image;
    this.size = options.size ?? DEFAULT_KILN_SANDBOX_SIZE;
    this.template = templateName(options.image, this.size);
    this.warmSnapshots = {
      template: this.template,
      take: (ref) => this.options.gateway.snapshot(ref.id),
      restore: (input, snapshotId) => this.start(input, snapshotId),
      // A snapshot that E2B does not find is removed.
      remove: async (snapshotId) => {
        await this.options.gateway.deleteSnapshot(snapshotId);
        return true;
      },
    };
  }

  async create(input: SandboxCreateInput): Promise<SandboxRef> {
    await this.ensureTemplate();
    return this.start(input, this.template);
  }

  attachEnvironment(ref: SandboxRef, environment: Record<string, string>): void {
    this.attached.set(ref.id, { ...environment });
  }

  async applyNetworkPolicy(ref: SandboxRef, policy: NetworkPolicy): Promise<void> {
    await this.keepAlive(ref);
    await this.options.gateway.setEgress(ref.id, normalizeNetworkPolicy(policy).allowedDomains);
  }

  async exec(ref: SandboxRef, command: Command): Promise<CommandResult> {
    await this.keepAlive(ref);
    const startedAt = Date.now();
    const envs = this.environmentFor(ref, command.env, command.isolated);
    const result = await this.options.gateway.run(ref.id, commandLine([command.file, ...command.args], envs), {
      cwd: this.resolveCwd(ref, command.cwd),
      envs,
      user: SANDBOX_USER,
      timeoutMs: command.timeoutMs ?? 0,
    });
    const durationMs = Date.now() - startedAt;
    if (result.timedOut) {
      return { exitCode: 124, stdout: result.stdout, stderr: "the command reached its timeout", timedOut: true, durationMs };
    }
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: false, durationMs };
  }

  async writeFile(ref: SandboxRef, path: string, content: string): Promise<void> {
    await this.keepAlive(ref);
    await this.options.gateway.writeFile(ref.id, path, content, SANDBOX_USER);
  }

  /**
   * DI-2.10, as on Sprites. E2B streams the output of a background command only to the client
   * that started it, and a later activity on another worker reads the process. A wrapper writes
   * the pid, the output, the error output and, last, the exit code to files. The directory exists
   * before this method returns, so a read of an identifier this adapter never issued fails.
   */
  async startProcess(ref: SandboxRef, command: Command): Promise<ProcessRef> {
    await this.keepAlive(ref);
    const id = `proc-${randomUUID().slice(0, 8)}`;
    const dir = processDir(id);
    const envs = this.environmentFor(ref, command.env, command.isolated);
    await this.options.gateway.makeDirectory(ref.id, dir, SANDBOX_USER);
    await this.options.gateway.start(
      ref.id,
      commandLine(["sh", "-c", processWrapperScript(dir), "sh", command.file, ...command.args], envs),
      { cwd: this.resolveCwd(ref, command.cwd), envs, user: SANDBOX_USER },
    );
    return { id };
  }

  async readProcess(ref: SandboxRef, process: ProcessRef): Promise<ProcessSnapshot> {
    await this.keepAlive(ref);
    const dir = processDir(process.id);
    const gateway = this.options.gateway;
    // The exit file comes first. The wrapper writes it last, so the output read after it is whole.
    const exitText = await gateway.readFile(ref.id, posix.join(dir, "exit"), SANDBOX_USER);
    const [present, stdout, stderr] = await Promise.all([
      gateway.exists(ref.id, dir, SANDBOX_USER),
      gateway.readFile(ref.id, posix.join(dir, "out"), SANDBOX_USER),
      gateway.readFile(ref.id, posix.join(dir, "err"), SANDBOX_USER),
    ]);
    if (!present) throw new SandboxError(`e2b has no process ${process.id} in sandbox ${ref.id}`, this.name);
    const parsed = exitText === null ? Number.NaN : Number.parseInt(exitText.trim(), 10);
    const exitCode = Number.isNaN(parsed) ? null : parsed;
    return { running: exitCode === null, exitCode, stdout: stdout ?? "", stderr: stderr ?? "" };
  }

  /**
   * DI-2.10, as on Sprites. A cancel marker stops a wrapper that has not started the command yet.
   * A bounded reread of the pid file then finds a command that has started, and its process group
   * gets TERM.
   */
  async cancelProcess(ref: SandboxRef, process: ProcessRef): Promise<void> {
    const gateway = this.options.gateway;
    const dir = processDir(process.id);
    try {
      await this.keepAlive(ref);
      if (!(await gateway.exists(ref.id, dir, SANDBOX_USER))) return;
      await gateway.writeFile(ref.id, posix.join(dir, "cancel"), "", SANDBOX_USER);
      let pid = "";
      for (let attempt = 0; attempt < CANCEL_PID_ATTEMPTS && pid === ""; attempt += 1) {
        if (attempt > 0) await delay(this.options.cancelRetryMs ?? CANCEL_RETRY_MS);
        pid = ((await gateway.readFile(ref.id, posix.join(dir, "pid"), SANDBOX_USER)) ?? "").trim();
      }
      if (!/^[0-9]+$/.test(pid)) return;
      const kill = `kill -TERM -${pid} 2>/dev/null || kill -TERM ${pid} 2>/dev/null; true`;
      const envs = { PATH: E2B_PATH, ...DOCKER_ENVIRONMENT };
      await gateway.run(ref.id, commandLine(["sh", "-c", kill], envs), {
        cwd: "/",
        envs,
        user: SANDBOX_USER,
        timeoutMs: 30_000,
      });
    } catch {
      // Cancellation is idempotent. A process or a sandbox that has gone is cancelled.
    }
  }

  checkpoint(): Promise<CheckpointRef> {
    return Promise.reject(new SandboxError("e2b takes warm snapshots, not run checkpoints", this.name));
  }

  async exposeService(ref: SandboxRef, port: number): Promise<ServiceRef> {
    try {
      await this.keepAlive(ref);
      // DI-14.17. The host holds the random sandbox id, and the sandbox allows public traffic.
      const host = await this.options.gateway.host(ref.id, port);
      return { port, url: `https://${host}` };
    } catch (error) {
      throw new SandboxError(`e2b could not expose port ${port}: ${String(error)}`, this.name);
    }
  }

  async destroy(ref: SandboxRef): Promise<void> {
    this.attached.delete(ref.id);
    this.lastKeepAlive.delete(ref.id);
    try {
      await this.options.gateway.kill(ref.id);
    } catch {
      // Destruction is idempotent. A sandbox that has gone is destroyed.
    }
  }

  /** A create and a restore send the same metadata: the run that owns the new sandbox (issue #5). */
  private async start(input: SandboxCreateInput, source: string): Promise<SandboxRef> {
    // The environment never goes to E2B at create time. A warm snapshot of a sandbox created with
    // one would carry it into the next run. It reaches each command.
    const id = await this.options.gateway.createSandbox({
      source,
      metadata: { factoree_run_id: input.runId, factoree_tenant_id: input.tenantId },
      timeoutMs: IDLE_MS,
    });
    this.attached.set(id, { ...(input.environment ?? {}) });
    this.lastKeepAlive.set(id, this.now());
    await this.openDevices(id);
    return { id, adapter: this.name, workspacePath: DEFAULT_WORKSPACE };
  }

  /**
   * DI-21.29. The E2B guest kernel makes /dev/net/tun and /dev/fuse root-only at boot, and no udev
   * opens them, so rootless Docker cannot create the TAP device of slirp4netns. Kiln opens both in
   * its guest init (DI-21.12). A guest without a device still serves a run without Docker, so a
   * failed chmod is no fault here; `factoree-docker-start` reports it when Docker needs the device.
   */
  private async openDevices(id: string): Promise<void> {
    await this.options.gateway.run(id, "chmod 0666 /dev/net/tun /dev/fuse 2>/dev/null || true", {
      cwd: "/",
      envs: {},
      user: ROOT_USER,
      timeoutMs: DEVICE_CHMOD_TIMEOUT_MS,
    });
  }

  private async keepAlive(ref: SandboxRef): Promise<void> {
    const last = this.lastKeepAlive.get(ref.id);
    const now = this.now();
    if (last !== undefined && now - last < KEEP_ALIVE_EVERY_MS) return;
    await this.options.gateway.keepAlive(ref.id, IDLE_MS);
    this.lastKeepAlive.set(ref.id, now);
  }

  /**
   * Builds the template of the image digest and size once per worker. E2B caches each build
   * step, so a later build of the same image finishes fast. A template whose last build failed
   * builds again, because no state outlives the worker.
   */
  private ensureTemplate(): Promise<void> {
    this.templateReady ??= this.options.gateway
      .buildTemplate({
        name: this.template,
        image: this.image,
        user: SANDBOX_USER,
        cpuCount: this.size.vcpus,
        memoryMb: this.size.memoryMb,
        ...(this.options.registryCredential === undefined ? {} : { credential: this.options.registryCredential }),
      })
      .catch((error: unknown) => {
        this.templateReady = null;
        throw new SandboxError(`the E2B template ${this.template} for ${this.image} failed: ${String(error)}`, this.name);
      });
    return this.templateReady;
  }

  private environmentFor(
    ref: SandboxRef,
    env: Record<string, string> | undefined,
    isolated = false,
  ): Record<string, string> {
    const attached = isolated ? {} : (this.attached.get(ref.id) ?? {});
    return { PATH: E2B_PATH, ...DOCKER_ENVIRONMENT, ...attached, ...(env ?? {}) };
  }

  private resolveCwd(ref: SandboxRef, cwd: string | undefined): string {
    if (cwd === undefined) return ref.workspacePath;
    return posix.isAbsolute(cwd) ? cwd : posix.join(ref.workspacePath, cwd);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

const processDir = (id: string): string => posix.join(PROCESS_ROOT, id);

/** Quotes one value for safe use inside a POSIX shell single-quoted string. */
const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The shell string E2B runs. Each argument is quoted, so the shell never splits it again. The
 * string sets the `PATH` of the command environment again, because the login shell has replaced
 * it by then. `PATH` holds no secret, so it may appear in the command line.
 */
export const commandLine = (argv: string[], envs: Record<string, string>): string =>
  `PATH=${shQuote(envs.PATH ?? E2B_PATH)}; export PATH; exec ${argv.map(shQuote).join(" ")}`;

/**
 * The wrapper `startProcess` runs under `sh -c`. It receives the command as positional
 * parameters, through `"$@"`. `set -m` puts the command in its own process group, so a cancel
 * reaches every child.
 */
export const processWrapperScript = (dir: string): string => {
  const file = (name: string): string => shQuote(posix.join(dir, name));
  return [
    "set -m",
    `if [ -e ${file("cancel")} ]; then echo 143 >${file("exit")}; exit 0; fi`,
    `"$@" >${file("out")} 2>${file("err")} &`,
    "child=$!",
    `echo "$child" >${file("pid")}`,
    'wait "$child"',
    "ec=$?",
    `echo "$ec" >${file("exit")}`,
  ].join("\n");
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
