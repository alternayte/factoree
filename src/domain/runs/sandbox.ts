/** SDD section 31. A reference to one live sandbox. One Run uses one unique sandbox. */
export interface SandboxRef {
  /** Adapter-scoped identifier. This value is stored as `Run.spriteId`. */
  id: string;
  /**
   * The sandbox provider that owns this sandbox, for example `kiln` or `e2b-3f2a1c`
   * (docs/specs/sandbox-provider-spillover.md). The first provider of a type has the type name as
   * its id. A bare adapter outside `SettingsSandbox` writes its own name here.
   */
  adapter: string;
  /** The absolute path inside the sandbox that holds every checkout. */
  workspacePath: string;
}

export interface SandboxCreateInput {
  /** The Run that owns the sandbox. One Run owns exactly one sandbox. */
  runId: string;
  tenantId: string;
  productId: string;
  /** Memory in megabytes. The adapter chooses a default when this is absent. */
  memoryMb?: number;
  cpus?: number;
  region?: string;
  /**
   * Environment values available to every command. `SandboxManager.prepare` also attaches them
   * with `attachEnvironment`, so an adapter that cannot set an environment at creation time still
   * delivers them. A Project secret belongs here only when its kind permits an agent session to
   * hold it. See SDD section 30.
   */
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
   * Runs the command without the environment attached to the sandbox, so it sees the base
   * environment of the adapter and `env` alone.
   *
   * SDD section 35 requires a clean shell for deterministic verification, and SDD section 30
   * permits only a marked Project test secret in such a command. The runner credential of an
   * agent session must not reach it. The base environment of the adapter still applies, because
   * `PATH` and `HOME` belong to the sandbox, not to any session.
   */
  isolated?: boolean;
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
  /**
   * docs/specs/kiln-sandbox-provider.md. True when every sandbox starts from the Factoree sandbox
   * image, which holds the runner CLIs root-owned and the browser tools. False means the run
   * installs the browser tools itself, and B-2 stays open on that adapter.
   */
  supportsCustomImage: boolean;
  /**
   * docs/specs/repository-setup-and-services.md. True when the sandbox image runs rootless Docker
   * as the sandbox user, so a compose stack and Testcontainers work. A checkpoint that keeps no
   * process, or a sandbox without the image, has it false.
   */
  supportsDocker: boolean;
}

/**
 * docs/specs/kiln-sandbox-provider.md. A provider that can save a prepared sandbox and start a new
 * sandbox from it. Only an adapter that can fork a saved state into a new sandbox has it.
 */
export interface WarmSnapshots {
  /**
   * docs/specs/kiln-sandbox-size.md. The template a new sandbox starts from: the image digest and
   * the size. A snapshot of another template holds another toolchain or size, and is not used.
   */
  readonly template: string;
  /** Saves the sandbox as it is now, and returns the snapshot id. The sandbox keeps running. */
  take(ref: SandboxRef): Promise<string>;
  /** Starts a new sandbox from a snapshot, with the egress policy the snapshot recorded. */
  restore(input: SandboxCreateInput, snapshotId: string): Promise<SandboxRef>;
  /**
   * Removes a snapshot. A snapshot that has gone is removed. False means the provider kept it,
   * because a live sandbox still reads it, and a later call must try again.
   */
  remove(snapshotId: string): Promise<boolean>;
}

/** docs/specs/repository-setup-and-services.md. One host a sandbox reached or was denied. */
export interface EgressRecord {
  host: string;
  decision: "allowed" | "denied";
}

/** SDD section 31. */
export interface Sandbox {
  /** The adapter name, or the sandbox provider id. It appears in `SandboxRef.adapter` and in logs. */
  readonly name: string;
  readonly capabilities: SandboxCapabilities;
  /** The sandbox image by digest, when `supportsCustomImage` is true. */
  readonly image?: string | undefined;
  /** Present only when the adapter can start a sandbox from a warm snapshot. */
  readonly warmSnapshots?: WarmSnapshots | undefined;

  /**
   * docs/specs/release-0-1-0.md. Re-reads the provider settings, so the next sandbox uses the
   * provider the install settings name now. `SandboxManager` calls it before it prepares a
   * sandbox. An adapter with fixed settings leaves it out.
   */
  refresh?(): Promise<void>;
  /**
   * docs/specs/sandbox-provider-spillover.md. The view of one sandbox provider, when this sandbox
   * routes to several. A create through the view goes to that provider only.
   */
  forProvider?(providerId: string): Promise<Sandbox>;
  create(input: SandboxCreateInput): Promise<SandboxRef>;
  /**
   * docs/specs/repository-setup-and-services.md. The hosts the sandbox reached and the hosts its
   * allow list denied. Present only when the provider records egress.
   */
  egressLog?(ref: SandboxRef): Promise<EgressRecord[] | null>;
  /**
   * Holds an environment that every later `exec` and `startProcess` on this sandbox receives.
   *
   * `SandboxCreateInput.environment` alone cannot carry a value to a command: the Fly Sprites exec
   * API replaces the whole environment of each call, and the local adapter builds each child
   * environment from an allow list. A `Command.env` value still wins, so a caller can withhold the
   * environment from one command.
   *
   * The store is per process and per sandbox. An activity that execs into a sandbox another
   * activity created must call this again, with the value it reads from the Project secret store.
   * That re-read is deliberate: no credential then crosses a Temporal boundary.
   */
  attachEnvironment(ref: SandboxRef, environment: Record<string, string>): void;
  /** Applies the egress policy. `SandboxManager` calls this before any checkout. */
  applyNetworkPolicy(ref: SandboxRef, policy: NetworkPolicy): Promise<void>;
  exec(ref: SandboxRef, command: Command): Promise<CommandResult>;
  /**
   * Writes one file inside the sandbox.
   *
   * A prompt reaches an agent through a file, not through the environment. Linux carries at most
   * `MAX_ARG_STRLEN` bytes in one environment value, which is 131072, and a Reviewer prompt of a
   * real Run measured 202351 bytes. The environment can never carry it, whatever the transport
   * underneath. SDD section 30 keeps the prompt off the command line, and a file honours that:
   * the file holds the prompt of the session that reads it, and nothing else.
   */
  writeFile(ref: SandboxRef, path: string, content: string): Promise<void>;
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

/**
 * docs/specs/sandbox-provider-spillover.md. The sandbox provider failed to create a sandbox: the
 * call to the provider threw. A work sprite create that fails this way marks the provider down,
 * and the run selects another one.
 */
export class SandboxCreateError extends Error {
  constructor(
    readonly providerId: string,
    cause: unknown,
  ) {
    super(`the sandbox provider ${providerId} did not create a sandbox: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = "SandboxCreateError";
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

// A host name, or the conventional wildcard form `*.` followed by a host name. A bare `*`, and a
// wildcard label with no dot such as `*example.com`, have no defined meaning and stay rejected.
const HOST_NAME = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** True when `allowed` permits `domain`: the same host, or a wildcard that covers it. */
const covers = (allowed: string, domain: string): boolean => {
  if (allowed === domain) return true;
  if (!allowed.startsWith("*.")) return false;
  const suffix = allowed.slice(1);
  const host = domain.startsWith("*.") ? domain.slice(1) : `.${domain}`;
  return host.endsWith(suffix) && host !== suffix;
};

/**
 * docs/specs/egress-honesty-and-issue-status.md. True when an entry of `allowList` permits `host`:
 * the same host, or a wildcard that covers it. The comparison ignores case.
 */
export const allowListCovers = (allowList: readonly string[], host: string): boolean => {
  const domain = host.trim().toLowerCase();
  return allowList.some((allowed) => covers(allowed.trim().toLowerCase(), domain));
};

/**
 * R-4. The Product owns the egress ceiling. A repository can only narrow it: the result keeps the
 * repository entries the ceiling covers. A repository that declares nothing gets the ceiling.
 */
export const narrowAllowList = (repository: string[], ceiling: string[]): string[] => {
  const product = normalizeNetworkPolicy({ allowedDomains: ceiling }).allowedDomains;
  if (repository.length === 0) return product;
  const requested = normalizeNetworkPolicy({ allowedDomains: repository }).allowedDomains;
  return requested.filter((domain) => product.some((allowed) => covers(allowed, domain)));
};

/** Produces a stable, comparable policy. Two equal policies always produce one document. */
export const normalizeNetworkPolicy = (policy: NetworkPolicy): NetworkPolicy => {
  const domains = new Set<string>();
  for (const raw of policy.allowedDomains) {
    const domain = raw.trim().toLowerCase();
    if (!HOST_NAME.test(domain)) {
      throw new Error(`domain must be a host name, received "${raw}"`);
    }
    // R-4. `*.com` would allow most of the internet. A wildcard must name at least two labels.
    if (domain.startsWith("*.") && !domain.slice(2).includes(".")) {
      throw new Error(`a wildcard domain must name at least two labels, received "${raw}"`);
    }
    domains.add(domain);
  }
  return { allowedDomains: [...domains].sort() };
};
