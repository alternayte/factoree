import {
  ALL_TRAFFIC,
  CommandExitError,
  NotFoundError,
  Sandbox as E2BSdkSandbox,
  Template,
  TimeoutError,
  type ConnectionOpts,
  type SandboxOpts,
} from "e2b";

/**
 * docs/specs/e2b-sandbox-provider.md. The E2B calls the sandbox adapter needs, over the `e2b` SDK.
 * The adapter depends on this shape, so a unit test drives it without an E2B account.
 */
export interface E2BGateway {
  /** Starts a template build and waits until it is ready. Throws with the E2B reason on a failure. */
  buildTemplate(request: E2BTemplateRequest): Promise<void>;
  /** Creates a sandbox from a template name or a snapshot id, with all egress denied. Returns its id. */
  createSandbox(request: E2BSandboxRequest): Promise<string>;
  /** Connects to a sandbox, resumes it when it is paused, and extends its timeout. */
  keepAlive(sandboxId: string, timeoutMs: number): Promise<void>;
  /** Replaces the egress rules. An empty list denies all egress. */
  setEgress(sandboxId: string, allowedDomains: string[]): Promise<void>;
  run(sandboxId: string, command: string, options: E2BRunOptions): Promise<E2BRunResult>;
  /** Starts a command and returns as soon as it runs. The command outlives this client. */
  start(sandboxId: string, command: string, options: Omit<E2BRunOptions, "timeoutMs">): Promise<void>;
  /** The content of a file, or null when it does not exist. */
  readFile(sandboxId: string, path: string, user: string): Promise<string | null>;
  writeFile(sandboxId: string, path: string, content: string, user: string): Promise<void>;
  makeDirectory(sandboxId: string, path: string, user: string): Promise<void>;
  exists(sandboxId: string, path: string, user: string): Promise<boolean>;
  /** The public host name of a port, without a scheme. */
  host(sandboxId: string, port: number): Promise<string>;
  /** Takes a snapshot with memory. The sandbox keeps running. Returns the snapshot id. */
  snapshot(sandboxId: string): Promise<string>;
  /** False when E2B has no such snapshot. */
  deleteSnapshot(snapshotId: string): Promise<boolean>;
  /** Deletes a sandbox, also a paused one. A sandbox E2B no longer has is a no-op; any other error throws. */
  kill(sandboxId: string): Promise<void>;
}

export interface E2BTemplateRequest {
  name: string;
  image: string;
  user: string;
  cpuCount: number;
  memoryMb: number;
  credential?: { username: string; token: string };
}

export interface E2BSandboxRequest {
  /** A template name, or a snapshot id. */
  source: string;
  metadata: Record<string, string>;
  timeoutMs: number;
}

export interface E2BRunOptions {
  cwd: string;
  envs: Record<string, string>;
  user: string;
  /** Zero means no limit. */
  timeoutMs: number;
}

export type E2BRunResult =
  | { timedOut: false; exitCode: number; stdout: string; stderr: string }
  | { timedOut: true; stdout: string; stderr: string };

export interface E2BConnection {
  apiKey: string;
  /** The E2B domain. Absent means the SDK default, `e2b.app`. */
  domain?: string;
}

const TEMPLATE_POLL_MS = 5_000;
const TEMPLATE_WAIT_MS = 30 * 60_000;

/** The gateway over the E2B SDK. It keeps one connected SDK object per sandbox. */
export const createE2BGateway = (connection: E2BConnection): E2BGateway => {
  const opts: ConnectionOpts = {
    apiKey: connection.apiKey,
    ...(connection.domain === undefined ? {} : { domain: connection.domain }),
  };
  const connected = new Map<string, Promise<E2BSdkSandbox>>();

  const sandbox = (sandboxId: string): Promise<E2BSdkSandbox> => {
    let entry = connected.get(sandboxId);
    if (entry === undefined) {
      entry = E2BSdkSandbox.connect(sandboxId, opts);
      // A failed connect must not stay cached. The next call connects again.
      entry.catch(() => connected.delete(sandboxId));
      connected.set(sandboxId, entry);
    }
    return entry;
  };

  return {
    async buildTemplate(request) {
      const template = Template()
        .fromImage(
          request.image,
          request.credential === undefined
            ? undefined
            : { username: request.credential.username, password: request.credential.token },
        )
        .setUser(request.user);
      const build = await Template.buildInBackground(template, request.name, {
        ...opts,
        cpuCount: request.cpuCount,
        memoryMB: request.memoryMb,
      });
      const deadline = Date.now() + TEMPLATE_WAIT_MS;
      for (;;) {
        const status = await Template.getBuildStatus(build, opts);
        if (status.status === "ready") return;
        if (status.status === "error") {
          throw new Error(`the E2B template ${request.name} failed: ${JSON.stringify(status.reason ?? "no reason given")}`);
        }
        if (Date.now() >= deadline) throw new Error(`the E2B template ${request.name} is still building`);
        await new Promise((resolve) => setTimeout(resolve, TEMPLATE_POLL_MS));
      }
    },

    async createSandbox(request) {
      const options: SandboxOpts = {
        ...opts,
        metadata: request.metadata,
        timeoutMs: request.timeoutMs,
        // A paused sandbox keeps its memory, and the next call wakes it.
        lifecycle: { onTimeout: "pause", autoResume: true },
        network: {
          denyOut: [ALL_TRAFFIC],
          // DI-14.17. The browser on the worker opens the preview with no E2B key.
          allowPublicTraffic: true,
        },
      };
      const created = await E2BSdkSandbox.create(request.source, options);
      connected.set(created.sandboxId, Promise.resolve(created));
      return created.sandboxId;
    },

    async keepAlive(sandboxId, timeoutMs) {
      // A connect resumes a paused sandbox and extends the timeout of a running one.
      const entry = E2BSdkSandbox.connect(sandboxId, { ...opts, timeoutMs });
      connected.set(sandboxId, entry);
      await entry.catch((error: unknown) => {
        connected.delete(sandboxId);
        throw error;
      });
    },

    async setEgress(sandboxId, allowedDomains) {
      await (await sandbox(sandboxId)).updateNetwork(
        allowedDomains.length === 0
          ? { denyOut: [ALL_TRAFFIC] }
          : { denyOut: [ALL_TRAFFIC], allowOut: allowedDomains },
      );
    },

    async run(sandboxId, command, options) {
      const handle = await sandbox(sandboxId);
      try {
        const result = await handle.commands.run(command, {
          cwd: options.cwd,
          envs: options.envs,
          user: options.user,
          timeoutMs: options.timeoutMs,
        });
        return { timedOut: false, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        // A non-zero exit code is a result, not a fault.
        if (error instanceof CommandExitError) {
          return { timedOut: false, exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
        }
        // Without a command limit, a timeout belongs to a request, and it is a fault.
        if (error instanceof TimeoutError && options.timeoutMs > 0) {
          return { timedOut: true, stdout: "", stderr: error.message };
        }
        throw error;
      }
    },

    async start(sandboxId, command, options) {
      const handle = await (await sandbox(sandboxId)).commands.run(command, {
        background: true,
        cwd: options.cwd,
        envs: options.envs,
        user: options.user,
        timeoutMs: 0,
      });
      // The command keeps running. Only the output stream to this client closes.
      await handle.disconnect();
    },

    async readFile(sandboxId, path, user) {
      try {
        return await (await sandbox(sandboxId)).files.read(path, { user });
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },

    async writeFile(sandboxId, path, content, user) {
      await (await sandbox(sandboxId)).files.write(path, content, { user });
    },

    async makeDirectory(sandboxId, path, user) {
      await (await sandbox(sandboxId)).files.makeDir(path, { user });
    },

    async exists(sandboxId, path, user) {
      return (await sandbox(sandboxId)).files.exists(path, { user });
    },

    async host(sandboxId, port) {
      return (await sandbox(sandboxId)).getHost(port);
    },

    async snapshot(sandboxId) {
      const snapshot = await E2BSdkSandbox.createSnapshot(sandboxId, opts);
      return snapshot.snapshotId;
    },

    deleteSnapshot: (snapshotId) => E2BSdkSandbox.deleteSnapshot(snapshotId, opts),

    async kill(sandboxId) {
      connected.delete(sandboxId);
      await E2BSdkSandbox.kill(sandboxId, opts);
    },
  };
};
