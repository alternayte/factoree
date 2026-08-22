/** SDD section 31. A reference to one live sandbox. One Run uses one unique sandbox. */
export interface SandboxRef {
  /** Adapter-scoped identifier. This value is stored as `Run.spriteId`. */
  id: string;
  /** The adapter that owns this sandbox, for example `fly-sprites` or `local`. */
  adapter: string;
  /** The absolute path inside the sandbox that holds every checkout. */
  workspacePath: string;
}

export interface SandboxCreateInput {
  /** The Run that owns the sandbox. One Run owns exactly one sandbox. */
  runId: string;
  tenantId: string;
  projectId: string;
  /** Memory in megabytes. The adapter chooses a default when this is absent. */
  memoryMb?: number;
  cpus?: number;
  region?: string;
  /** Environment values available to every command. Never place a secret here unless it is a Project test secret. */
  environment?: Record<string, string>;
}

export interface Command {
  /** The executable. This is not a shell string. */
  file: string;
  args: string[];
  /** Absolute path, or a path relative to `SandboxRef.workspacePath`. */
  cwd?: string;
  env?: Record<string, string>;
  /**
   * The deadline for `exec` only. `startProcess` ignores this field. A caller of `startProcess`
   * must enforce its own deadline and stop the process with `cancelProcess`.
   */
  timeoutMs?: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the command was stopped by its timeout rather than by exiting. */
  timedOut: boolean;
  durationMs: number;
}

export interface ProcessRef {
  id: string;
}

export interface CheckpointRef {
  id: string;
  name: string;
}

export interface ServiceRef {
  port: number;
  url: string;
}

/** SDD section 29. The sandbox egress allow list. An empty list denies all egress. */
export interface NetworkPolicy {
  allowedDomains: string[];
}

export interface SandboxCapabilities {
  /**
   * True only when the adapter denies egress to a domain outside the allow list at the
   * network layer. A model instruction is not a security boundary. SDD section 29
   * requires enforcement outside the prompt.
   */
  enforcesNetworkPolicy: boolean;
  /** True when the adapter can create a restorable checkpoint. */
  supportsCheckpoints: boolean;
  /** True when the adapter can publish a port to a reachable URL. */
  supportsExposedServices: boolean;
}

/** SDD section 31. */
export interface Sandbox {
  /** The adapter name. It appears in `SandboxRef.adapter` and in logs. */
  readonly name: string;
  readonly capabilities: SandboxCapabilities;

  create(input: SandboxCreateInput): Promise<SandboxRef>;
  /** Applies the egress policy. `SandboxManager` calls this before any checkout. */
  applyNetworkPolicy(ref: SandboxRef, policy: NetworkPolicy): Promise<void>;
  exec(ref: SandboxRef, command: Command): Promise<CommandResult>;
  /** Ignores `Command.timeoutMs`. The caller must enforce its own deadline. */
  startProcess(ref: SandboxRef, command: Command): Promise<ProcessRef>;
  /** Reads whatever the process has written so far and reports whether it has exited. */
  readProcess(ref: SandboxRef, process: ProcessRef): Promise<ProcessSnapshot>;
  cancelProcess(ref: SandboxRef, process: ProcessRef): Promise<void>;
  checkpoint(ref: SandboxRef, name: string): Promise<CheckpointRef>;
  exposeService(ref: SandboxRef, port: number): Promise<ServiceRef>;
  destroy(ref: SandboxRef): Promise<void>;
}

export interface ProcessSnapshot {
  running: boolean;
  /** Null while the process is still running. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly adapter: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SandboxError";
  }
}

export class NetworkPolicyNotEnforcedError extends Error {
  constructor(readonly adapter: string) {
    super(
      `Sandbox adapter ${adapter} cannot enforce a network policy. ` +
        "Refusing to run an agent, because SDD section 29 denies arbitrary outbound network access.",
    );
    this.name = "NetworkPolicyNotEnforcedError";
  }
}

const HOST_NAME = /^\*?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Produces a stable, comparable policy. Two equal policies always produce one document. */
export const normalizeNetworkPolicy = (policy: NetworkPolicy): NetworkPolicy => {
  const domains = new Set<string>();
  for (const raw of policy.allowedDomains) {
    const domain = raw.trim().toLowerCase();
    if (!HOST_NAME.test(domain)) {
      throw new Error(`domain must be a host name, received "${raw}"`);
    }
    domains.add(domain);
  }
  return { allowedDomains: [...domains].sort() };
};
