import { randomUUID } from "node:crypto";
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
import type { SpritesGateway } from "./sprites-client.js";
import { toSpritesNetworkPolicy } from "./network-policy.js";

export interface FlySpriteSandboxOptions {
  gateway: SpritesGateway;
  /** The directory inside the sprite that holds every checkout. */
  workspacePath?: string;
  config?: { ramMB?: number; cpus?: number; region?: string };
}

const DEFAULT_WORKSPACE = "/workspace";

/** SDD section 31. The required Sandbox implementation. */
export class FlySpriteSandbox implements Sandbox {
  readonly name = "fly-sprites";
  readonly capabilities: SandboxCapabilities = {
    enforcesNetworkPolicy: true,
    supportsCheckpoints: true,
    supportsExposedServices: true,
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

  async startProcess(ref: SandboxRef, command: Command): Promise<ProcessRef> {
    const session = await this.options.gateway.sprite(ref.id).createSession(command.file, command.args, {
      cwd: this.resolveCwd(ref, command.cwd),
      env: command.env ?? {},
    });
    return { id: session.sessionId };
  }

  async readProcess(ref: SandboxRef, process: ProcessRef): Promise<ProcessSnapshot> {
    return await this.options.gateway.sprite(ref.id).readSession(process.id);
  }

  async cancelProcess(ref: SandboxRef, process: ProcessRef): Promise<void> {
    try {
      await this.options.gateway.sprite(ref.id).killSession(process.id);
    } catch {
      // Cancellation is idempotent. A session that has already gone is cancelled.
    }
  }

  async checkpoint(ref: SandboxRef, name: string): Promise<CheckpointRef> {
    const created = await this.options.gateway.sprite(ref.id).createCheckpoint(name);
    return { id: created.id, name };
  }

  async exposeService(ref: SandboxRef, port: number): Promise<ServiceRef> {
    const service = await this.options.gateway.sprite(ref.id).createService(port);
    return { port, url: service.url };
  }

  async destroy(ref: SandboxRef): Promise<void> {
    try {
      await this.options.gateway.sprite(ref.id).delete();
    } catch {
      // Destruction is idempotent. A sprite that has already gone is destroyed.
    }
  }

  private resolveCwd(ref: SandboxRef, cwd: string | undefined): string {
    if (cwd === undefined) return ref.workspacePath;
    return isAbsolute(cwd) ? cwd : join(ref.workspacePath, cwd);
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
