import type { Checkpoint, Sprite } from "@fly/sprites";
import { SpritesClient } from "@fly/sprites";

/**
 * The narrow seam over `@fly/sprites`. Only this file knows the SDK. The adapter above it, the
 * domain, and the tests depend on these types instead. SDD section 12 requires that Fly Sprites
 * be replaceable. This seam keeps the replacement local.
 */
export interface SpritesExecOptions {
  cwd: string;
  env: Record<string, string>;
  timeout?: number;
}

export interface SpritesExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// This interface declares its members as function-typed properties rather than as method
// signatures. A test fake assigns a `vi.fn()` to each member. ESLint's `unbound-method` rule
// flags a method signature read off an object, because a method can depend on its receiver. A
// function-typed property carries no such risk, so the rule leaves it alone.
export interface SpritesSpriteHandle {
  /**
   * Writes one file inside the sprite. The content travels in the body of the request, so a
   * large value never reaches a URL. See `SpritesSpriteHandle.startDetached`.
   */
  writeFile: (path: string, content: string) => Promise<void>;
  execFile: (file: string, args: string[], options: SpritesExecOptions) => Promise<SpritesExecResult>;
  /**
   * Starts a detachable session that stays alive after this call returns, and after the
   * client disconnects. `FlySpriteSandbox.startProcess` uses this only to launch its shell
   * wrapper. It tracks the wrapper's progress through files the wrapper writes, not through a
   * session identifier, so this returns nothing. See
   * docs/build/decisions.md, DI-2.10.
   */
  startDetached: (file: string, args: string[], options: SpritesExecOptions) => Promise<void>;
  createCheckpoint: (comment: string) => Promise<{ id: string }>;
  updateNetworkPolicy: (policy: { rules: Array<{ domain: string; action: "allow" | "deny" }> }) => Promise<void>;
  delete: () => Promise<void>;
}

export interface SpritesCreateOptions {
  ramMB?: number;
  cpus?: number;
  region?: string;
  environment?: Record<string, string>;
}

export interface SpritesGateway {
  createSprite: (
    name: string,
    options: SpritesCreateOptions,
  ) => Promise<{ name: string; handle: SpritesSpriteHandle }>;
  sprite: (name: string) => SpritesSpriteHandle;
}

export interface SpritesGatewayOptions {
  token: string;
  baseUrl?: string;
}

/**
 * The SDD chunk that first drafted this file assumed the real SDK names a timeout error
 * `TimeoutError`. The real SDK instead resolves a timed-out command with a plain `Error` and no
 * name of its own. This function restores the name `FlySpriteSandbox` expects, so it needs no
 * change to recognise a timeout. It also normalizes a non-zero exit failure's `stdout` and
 * `stderr`, which the SDK types as `string | Buffer`, to a string in every case, the same way
 * the success path already does, so a `Buffer` never silently becomes an empty string
 * downstream.
 */
const stringifyExecOutput = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
};

const normalizeExecFailure = (error: unknown): unknown => {
  if (!(error instanceof Error)) return error;
  const candidate = error as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
  if (typeof candidate.exitCode === "number") {
    const stdout = stringifyExecOutput(candidate.stdout);
    const stderr = stringifyExecOutput(candidate.stderr);
    // The SDK defines `stdout` and `stderr` as getters with no setter, so a plain assignment
    // throws a TypeError and hides the real command failure. `defineProperty` replaces a
    // configurable accessor with a data property. A non-configurable accessor still refuses,
    // so the fallback below carries the same values on a new error instead.
    try {
      Object.defineProperty(error, "stdout", { value: stdout, writable: true, configurable: true });
      Object.defineProperty(error, "stderr", { value: stderr, writable: true, configurable: true });
      return error;
    } catch {
      const replacement = new Error(error.message);
      replacement.name = error.name;
      if (error.stack !== undefined) replacement.stack = error.stack;
      return Object.assign(replacement, { exitCode: candidate.exitCode, stdout, stderr });
    }
  }
  if (error.name !== "AbortError" && /^Command timed out after/.test(error.message)) {
    error.name = "TimeoutError";
  }
  return error;
};

const pickLatestCheckpoint = (checkpoints: Checkpoint[], comment: string): Checkpoint | undefined => {
  const matching = checkpoints.filter((checkpoint) => checkpoint.comment === comment);
  const candidates = matching.length > 0 ? matching : checkpoints;
  return candidates.reduce<Checkpoint | undefined>(
    (best, candidate) => (best === undefined || candidate.createTime > best.createTime ? candidate : best),
    undefined,
  );
};

/**
 * Wraps one SDK sprite as the narrow handle above. It is exported so a test can drive it with a
 * fake sprite, which is the only way to reproduce the event behaviour of a broken connection.
 */
export const wrapSprite = (sprite: Sprite): SpritesSpriteHandle => ({
  writeFile: async (path, content) => {
    await sprite.filesystem("/").writeFile(path, content);
  },
  execFile: async (file, args, execOptions) => {
    try {
      const result = await sprite.execFile(file, args, {
        cwd: execOptions.cwd,
        env: execOptions.env,
        ...(execOptions.timeout === undefined ? {} : { timeout: execOptions.timeout }),
      });
      return { exitCode: result.exitCode, stdout: String(result.stdout), stderr: String(result.stderr) };
    } catch (error) {
      throw normalizeExecFailure(error);
    }
  },
  startDetached: async (file, args, execOptions) => {
    // `Sprite.createSession` starts the command asynchronously and returns immediately. Wait
    // for the `spawn` event so a failure to start is reported here, then close this client's
    // side of the connection. The session itself, and the command it runs, stays alive on the
    // sprite.
    const command = sprite.createSession(file, args, { cwd: execOptions.cwd, env: execOptions.env });

    // The listener stays attached for the life of the command, and it is not a `once` listener.
    // A `SpriteCommand` reports a broken connection as an `error` event, and it reports the
    // socket closing as a second one. A `once` listener answers the first and leaves the second
    // with no listener at all, and an `EventEmitter` with no listener for `error` throws. That
    // throw reached no caller: it ended the worker process, in the middle of a Run that had
    // already passed implementation, verification, and user validation.
    let settled = false;
    let failure: Error | null = null;
    command.on("error", (error: unknown) => {
      const asError = error instanceof Error ? error : new Error(String(error));
      // The first error decides the outcome. A later one is the same fault reported again, and
      // this listener exists to absorb it.
      failure ??= asError;
      settled = true;
    });

    await new Promise<void>((resolve, reject) => {
      if (settled) {
        reject(failure ?? new Error("the sprite session failed to start"));
        return;
      }
      command.once("spawn", () => resolve());
      command.on("error", () => reject(failure ?? new Error("the sprite session failed to start")));
    });

    // A close of a connection that already failed throws nothing a caller can act on.
    try {
      command.close();
    } catch {
      // The session runs on the sprite. This client's side of the connection is already gone.
    }
  },
  createCheckpoint: async (comment) => {
    const stream = await sprite.createCheckpoint(comment);
    for await (const message of stream) {
      if (message.type === "error") {
        throw new Error(message.error ?? message.data ?? "the checkpoint failed");
      }
    }
    const checkpoints = await sprite.listCheckpoints();
    const created = pickLatestCheckpoint(checkpoints, comment);
    if (created === undefined) {
      throw new Error("the sprite reported no checkpoint after createCheckpoint");
    }
    return { id: created.id };
  },
  updateNetworkPolicy: (policy) => sprite.updateNetworkPolicy(policy),
  delete: () => sprite.delete(),
});

export const createSpritesGateway = (options: SpritesGatewayOptions): SpritesGateway => {
  const client = new SpritesClient(options.token, {
    ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
  });

  return {
    createSprite: async (name, createOptions) => {
      const sprite = await client.createSprite(name, {
        config: {
          ...(createOptions.ramMB === undefined ? {} : { ramMB: createOptions.ramMB }),
          ...(createOptions.cpus === undefined ? {} : { cpus: createOptions.cpus }),
          ...(createOptions.region === undefined ? {} : { region: createOptions.region }),
        },
        ...(createOptions.environment === undefined ? {} : { environment: createOptions.environment }),
        waitForCapacity: true,
      });
      return { name: sprite.name, handle: wrapSprite(sprite) };
    },
    sprite: (name) => wrapSprite(client.sprite(name)),
  };
};
