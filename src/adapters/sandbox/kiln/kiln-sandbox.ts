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
import type { KilnClient, KilnTemplateRequest } from "./kiln-client.js";
import { isKilnConflict, isKilnNotFound } from "./kiln-client.js";

export interface KilnSandboxOptions {
  client: KilnClient;
  /** The Factoree sandbox image, `<name>@sha256:<hex>`. One template serves one digest and one size. */
  image: string;
  /** docs/specs/kiln-sandbox-size.md. The size of every sandbox. Absent means the default. */
  size?: KilnSandboxSize;
  /** The registry login for a private image. It reaches the template build only. */
  registryCredential?: { username: string; token: string };
  /** The first delay between two reads of a process. A test sets it to zero. */
  pollMs?: number;
  /** The longest wait for a template build. */
  templateWaitMs?: number;
}

// sandbox/Dockerfile creates this user. Every exec, process and file write runs as it, and the
// runner CLIs in RUNNER_BIN stay root-owned (B-2).
const SANDBOX_USER = "agent";
const DEFAULT_WORKSPACE = "/home/agent/workspace";
/** The root-owned directory of the runner CLIs and the browser tools in the sandbox image. */
export const KILN_RUNNER_BIN = "/opt/factoree/bin";

/**
 * Kilninit gives a child `HOME`, `USER` and a default `PATH`, and the image `ENV` reaches nobody.
 * The runner directory comes first, so a CLI the bootstrap installs in a user directory cannot
 * shadow it. The runners also call it by absolute path.
 */
const KILN_BASE_ENVIRONMENT: Record<string, string> = {
  PATH: `${KILN_RUNNER_BIN}:/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
};

// A template build pulls the image and boots it once, so the first run of a new digest waits.
// The prepare attempt is thirty minutes, and a retry keeps polling the same build.
const TEMPLATE_WAIT_MS = 20 * 60_000;
const TEMPLATE_POLL_MS = 5_000;
const TEMPLATE_DISK_MB = 16_384;


// A work sprite waits for check sprites and repairs between agent sessions. A persistent sandbox
// sleeps after this idle time and wakes on the next call with its disk and processes intact. Kiln
// never sleeps a sandbox while a detached process runs.
const IDLE_SECONDS = 600;

const POLL_MS = 50;
const POLL_MAX_MS = 1_000;

interface ProcessOutput {
  stdout: string;
  stderr: string;
  stdoutOffset: number;
  stderrOffset: number;
  running: boolean;
  exitCode: number | null;
}

/** docs/specs/kiln-sandbox-provider.md. Runs the work sprite and the check sprites on Kiln. */
export class KilnSandbox implements Sandbox {
  readonly name = "kiln";
  readonly capabilities: SandboxCapabilities = {
    // PUT /egress swaps the list at the host, outside the guest, and cuts open connections.
    enforcesNetworkPolicy: true,
    // A Kiln snapshot outlives its sandbox and holds disk until it is deleted. A baseline per run
    // would leak one per run, and nothing restores it. Warm snapshots use `warmSnapshots`.
    supportsCheckpoints: false,
    supportsExposedServices: true,
    supportsCustomImage: true,
  };
  readonly image: string;
  readonly warmSnapshots: WarmSnapshots;

  private readonly template: string;
  private readonly size: KilnSandboxSize;
  private templateReady: Promise<void> | null = null;
  private readonly attached = new Map<string, Record<string, string>>();
  /** The output read so far, by sandbox and process. A process this worker never read starts at zero. */
  private readonly outputs = new Map<string, ProcessOutput>();

  constructor(private readonly options: KilnSandboxOptions) {
    this.image = options.image;
    this.size = options.size ?? DEFAULT_KILN_SANDBOX_SIZE;
    this.template = templateName(options.image, this.size);
    this.warmSnapshots = {
      template: this.template,
      take: (ref) => this.options.client.snapshot(ref.id),
      restore: async (input, snapshotId) => {
        // The copy names this run, not the run whose sandbox took the snapshot (issue #5).
        const copy = await this.options.client.restoreSnapshot(snapshotId, sandboxMetadata(input));
        this.attached.set(copy.id, { ...(input.environment ?? {}) });
        return { id: copy.id, adapter: this.name, workspacePath: DEFAULT_WORKSPACE };
      },
      remove: async (snapshotId) => {
        try {
          await this.options.client.deleteSnapshot(snapshotId);
        } catch (error) {
          // A snapshot that has gone is removed. A snapshot a live sandbox still reads stays, and
          // Kiln refuses the delete with a conflict.
          if (isKilnNotFound(error)) return true;
          if (isKilnConflict(error)) return false;
          throw error;
        }
        return true;
      },
    };
  }

  async create(input: SandboxCreateInput): Promise<SandboxRef> {
    await this.ensureTemplate();
    // The environment never goes to Kiln at create time. A sandbox created with one is secret
    // bearing, and its warm snapshot would then refuse a plain restore. It reaches each command.
    const sandbox = await this.options.client.createSandbox({
      template: this.template,
      lifecycle: "persistent",
      idle_seconds: IDLE_SECONDS,
      metadata: sandboxMetadata(input),
    });
    this.attached.set(sandbox.id, { ...(input.environment ?? {}) });
    return { id: sandbox.id, adapter: this.name, workspacePath: DEFAULT_WORKSPACE };
  }

  attachEnvironment(ref: SandboxRef, environment: Record<string, string>): void {
    this.attached.set(ref.id, { ...environment });
  }

  async applyNetworkPolicy(ref: SandboxRef, policy: NetworkPolicy): Promise<void> {
    await this.options.client.setEgress(ref.id, normalizeNetworkPolicy(policy).allowedDomains);
  }

  /**
   * A detached process and a poll, not the buffered exec route. A bootstrap or a build runs for
   * minutes, and one long HTTP request then meets a client or proxy timeout. The process keeps
   * the last 8 MiB of each stream, so a command that lost output fails instead of returning a
   * truncated diff.
   */
  async exec(ref: SandboxRef, command: Command): Promise<CommandResult> {
    const startedAt = Date.now();
    const process = await this.startProcess(ref, command);
    const deadline = command.timeoutMs === undefined ? null : startedAt + command.timeoutMs;
    let wait = this.options.pollMs ?? POLL_MS;
    for (;;) {
      const output = await this.read(ref, process, true);
      if (!output.running) {
        this.outputs.delete(outputKey(ref, process));
        return {
          exitCode: output.exitCode ?? -1,
          stdout: output.stdout,
          stderr: output.stderr,
          timedOut: false,
          durationMs: Date.now() - startedAt,
        };
      }
      if (deadline !== null && Date.now() >= deadline) {
        await this.options.client.signalProcess(ref.id, process.id, "KILL").catch(() => undefined);
        this.outputs.delete(outputKey(ref, process));
        return {
          exitCode: 124,
          stdout: output.stdout,
          stderr: "the command reached its timeout",
          timedOut: true,
          durationMs: Date.now() - startedAt,
        };
      }
      await delay(wait);
      wait = Math.min(Math.max(wait * 2, 1), POLL_MAX_MS);
    }
  }

  async writeFile(ref: SandboxRef, path: string, content: string): Promise<void> {
    await this.options.client.writeFile(ref.id, path, content);
  }

  async startProcess(ref: SandboxRef, command: Command): Promise<ProcessRef> {
    const id = await this.options.client.startProcess(ref.id, {
      cmd: [command.file, ...command.args],
      cwd: this.resolveCwd(ref, command.cwd),
      env: this.environmentFor(ref, command.env, command.isolated),
    });
    return { id };
  }

  async readProcess(ref: SandboxRef, process: ProcessRef): Promise<ProcessSnapshot> {
    const output = await this.read(ref, process, false);
    return { running: output.running, exitCode: output.exitCode, stdout: output.stdout, stderr: output.stderr };
  }

  async cancelProcess(ref: SandboxRef, process: ProcessRef): Promise<void> {
    try {
      await this.options.client.signalProcess(ref.id, process.id, "TERM");
    } catch {
      // Cancellation is idempotent. A process or a sandbox that has gone is cancelled.
    }
  }

  checkpoint(): Promise<CheckpointRef> {
    return Promise.reject(new SandboxError("kiln takes warm snapshots, not run checkpoints", this.name));
  }

  async exposeService(ref: SandboxRef, port: number): Promise<ServiceRef> {
    try {
      // DI-14.17. A public, unguessable hostname: the browser on the worker holds no Kiln key.
      const published = await this.options.client.publish(ref.id, port);
      return { port, url: published.url.replace(/\/+$/, "") };
    } catch (error) {
      throw new SandboxError(`kiln could not publish port ${port}: ${String(error)}`, this.name);
    }
  }

  async destroy(ref: SandboxRef): Promise<void> {
    this.attached.delete(ref.id);
    for (const key of this.outputs.keys()) if (key.startsWith(`${ref.id}/`)) this.outputs.delete(key);
    try {
      await this.options.client.deleteSandbox(ref.id);
    } catch {
      // Destruction is idempotent. A sandbox that has gone is destroyed.
    }
  }

  /** Reads the new output of a process. Each call asks only for what follows the last offsets. */
  private async read(ref: SandboxRef, process: ProcessRef, strict: boolean): Promise<ProcessOutput> {
    const key = outputKey(ref, process);
    const output = this.outputs.get(key) ?? {
      stdout: "",
      stderr: "",
      stdoutOffset: 0,
      stderrOffset: 0,
      running: true,
      exitCode: null,
    };
    for (;;) {
      const page = await this.options.client.readProcess(ref.id, process.id, output.stdoutOffset, output.stderrOffset);
      if (strict && (page.stdout_lost > 0 || page.stderr_lost > 0)) {
        throw new SandboxError(
          `the command wrote more than Kiln keeps, and ${page.stdout_lost + page.stderr_lost} bytes were lost`,
          this.name,
        );
      }
      output.stdout += page.stdout;
      output.stderr += page.stderr;
      output.stdoutOffset = page.stdout_offset;
      output.stderrOffset = page.stderr_offset;
      output.running = page.running;
      output.exitCode = page.exit_code;
      if (!page.more) break;
    }
    this.outputs.set(key, output);
    return output;
  }

  /** Builds the template of the image digest once, and waits while another worker builds it. */
  private ensureTemplate(): Promise<void> {
    this.templateReady ??= this.buildTemplate().catch((error: unknown) => {
      this.templateReady = null;
      throw error;
    });
    return this.templateReady;
  }

  private async buildTemplate(): Promise<void> {
    const client = this.options.client;
    const deadline = Date.now() + (this.options.templateWaitMs ?? TEMPLATE_WAIT_MS);
    for (;;) {
      let state: string;
      try {
        const template = await client.template(this.template);
        if (template.state === "failed") {
          // A failed template stays on Kiln and would fail every later run, even after the cause
          // is fixed. It goes now, so the next attempt builds it again.
          await client.deleteTemplate(this.template).catch(() => undefined);
          throw new SandboxError(
            `the Kiln template ${this.template} for ${this.image} failed: ${template.error ?? "no reason given"}`,
            this.name,
          );
        }
        state = template.state;
      } catch (error) {
        if (!isKilnNotFound(error)) throw error;
        await this.requestTemplate();
        state = "building";
      }
      if (state === "ready") return;
      if (Date.now() >= deadline) {
        throw new SandboxError(`the Kiln template ${this.template} is still building`, this.name);
      }
      await delay(this.options.pollMs === 0 ? 0 : TEMPLATE_POLL_MS);
    }
  }

  private async requestTemplate(): Promise<void> {
    const request: KilnTemplateRequest = {
      name: this.template,
      image: this.image,
      vcpus: this.size.vcpus,
      memory_mb: this.size.memoryMb,
      disk_mb: TEMPLATE_DISK_MB,
      setup: [],
      // Factoree replaces the list on each sandbox before the first command.
      egress_allow: [],
      user: SANDBOX_USER,
      ...(this.options.registryCredential === undefined ? {} : { credential: this.options.registryCredential }),
    };
    try {
      await this.options.client.createTemplate(request);
    } catch (error) {
      // Another worker asked first. Its build is the one to wait for.
      if (!isKilnConflict(error)) throw error;
    }
  }

  private environmentFor(
    ref: SandboxRef,
    env: Record<string, string> | undefined,
    isolated = false,
  ): Record<string, string> {
    const attached = isolated ? {} : (this.attached.get(ref.id) ?? {});
    return { ...KILN_BASE_ENVIRONMENT, ...attached, ...(env ?? {}) };
  }

  private resolveCwd(ref: SandboxRef, cwd: string | undefined): string {
    if (cwd === undefined) return ref.workspacePath;
    return posix.isAbsolute(cwd) ? cwd : posix.join(ref.workspacePath, cwd);
  }
}

/**
 * docs/specs/kiln-sandbox-size.md. One template per image digest and size, so a size change builds
 * a new template and leaves the old one to the runs that still use it. A Kiln name allows
 * lower-case letters, digits and dashes.
 */
export const templateName = (image: string, size: KilnSandboxSize): string => {
  const digest = /@sha256:([0-9a-f]{64})$/.exec(image)?.[1];
  if (digest === undefined) throw new Error(`the Kiln image must name a digest, received "${image}"`);
  return `factoree-${digest.slice(0, 16)}-${size.vcpus}c-${size.memoryMb}m`;
};

const outputKey = (ref: SandboxRef, process: ProcessRef): string => `${ref.id}/${process.id}`;

/** How an operator finds the run of a sandbox in Kiln. A create and a restore send the same. */
const sandboxMetadata = (input: SandboxCreateInput): Record<string, string> => ({
  factoree_run_id: input.runId,
  factoree_tenant_id: input.tenantId,
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
