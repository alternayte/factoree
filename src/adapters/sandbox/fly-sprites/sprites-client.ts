import type { Checkpoint, Sprite } from "@fly/sprites";
import { SpritesClient } from "@fly/sprites";
import { SandboxError } from "~/domain/runs/sandbox.js";

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
  execFile: (file: string, args: string[], options: SpritesExecOptions) => Promise<SpritesExecResult>;
  /**
   * Starts a detachable session that stays alive after this call returns, and after the
   * client disconnects. `FlySpriteSandbox.startProcess` uses this only to launch its shell
   * wrapper. It tracks the wrapper's progress through files the wrapper writes, not through a
   * session identifier, so this returns nothing. See
   * docs/build/evidence/phase-02-sprites-sdk.md, item 4.
   */
  startDetached: (file: string, args: string[], options: SpritesExecOptions) => Promise<void>;
  createCheckpoint: (comment: string) => Promise<{ id: string }>;
  updateNetworkPolicy: (policy: { rules: Array<{ domain: string; action: "allow" | "deny" }> }) => Promise<void>;
  createService: (port: number) => Promise<{ url: string }>;
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

const ADAPTER_NAME = "fly-sprites";

/**
 * The SDD chunk that first drafted this file assumed the real SDK names a timeout error
 * `TimeoutError`. The real SDK instead resolves a timed-out command with a plain `Error` and no
 * name of its own. This function restores the name `FlySpriteSandbox` expects, so it needs no
 * change to recognise a timeout.
 */
const normalizeExecFailure = (error: unknown): unknown => {
  if (
    error instanceof Error &&
    typeof (error as { exitCode?: unknown }).exitCode !== "number" &&
    error.name !== "AbortError" &&
    /^Command timed out after/.test(error.message)
  ) {
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

const wrap = (sprite: Sprite): SpritesSpriteHandle => ({
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
    await new Promise<void>((resolve, reject) => {
      command.once("spawn", () => resolve());
      command.once("error", (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
    });
    command.close();
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
  createService: () => {
    // The real SDK has no documented API that publishes an existing port to a reachable URL.
    // `Sprite.createService` starts a new managed background process instead, and the service
    // it returns carries no URL. See docs/build/evidence/phase-02-sprites-sdk.md.
    throw new SandboxError(
      "the Fly Sprites SDK version 0.2.0 has no documented API that publishes a port to a " +
        "reachable URL, so FlySpriteSandbox cannot expose a service",
      ADAPTER_NAME,
    );
  },
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
      return { name: sprite.name, handle: wrap(sprite) };
    },
    sprite: (name) => wrap(client.sprite(name)),
  };
};
