import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Sprite, SpritesClient } from "@fly/sprites";
import { wrapSprite } from "~/adapters/sandbox/fly-sprites/sprites-client.js";

/**
 * A `SpriteCommand` of the SDK. It reports a broken connection as an `error` event, and it
 * reports the socket closing as a second one. An `EventEmitter` with no listener for `error`
 * throws, and that throw ended the worker process in a real Run, after implementation,
 * verification, and user validation had all passed.
 */
class FakeCommand extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

const spriteWith = (command: FakeCommand): Sprite =>
  ({ createSession: vi.fn().mockReturnValue(command) }) as unknown as Sprite;

const options = { cwd: "/home/sprite/workspace", env: { PATH: "/usr/bin" } };

describe("wrapSprite.startDetached", () => {
  it("returns once the session starts, and closes this side of the connection", async () => {
    const command = new FakeCommand();
    const handle = wrapSprite(spriteWith(command), {} as SpritesClient);

    const started = handle.startDetached("sh", ["-c", "true"], options);
    command.emit("spawn");
    await started;

    expect(command.closed).toBe(true);
  });

  it("reports the first error to the caller", async () => {
    const command = new FakeCommand();
    const handle = wrapSprite(spriteWith(command), {} as SpritesClient);

    const started = handle.startDetached("sh", ["-c", "true"], options);
    command.emit("error", new Error("WebSocket error: TypeError"));

    await expect(started).rejects.toThrow("WebSocket error: TypeError");
  });

  it("absorbs a second error, so a broken connection never ends the worker", async () => {
    const command = new FakeCommand();
    const handle = wrapSprite(spriteWith(command), {} as SpritesClient);

    const started = handle.startDetached("sh", ["-c", "true"], options);
    command.emit("error", new Error("WebSocket error: TypeError"));
    await expect(started).rejects.toThrow("WebSocket error");

    // The socket closes after the failure. With a `once` listener this throw had no listener at
    // all, and Node ended the process.
    expect(() => command.emit("error", new Error("socket closed"))).not.toThrow();
  });

  it("absorbs an error that arrives after the session started", async () => {
    const command = new FakeCommand();
    const handle = wrapSprite(spriteWith(command), {} as SpritesClient);

    const started = handle.startDetached("sh", ["-c", "true"], options);
    command.emit("spawn");
    await started;

    expect(() => command.emit("error", new Error("socket closed later"))).not.toThrow();
  });
});

describe("wrapSprite.execFileCaptured (FAC-49 to FAC-51 live runs)", () => {
  // The Sprites exec stream closed before its exit frame on six of eight tries when a command
  // printed a 192 KB diff, and the review reported exit code -1. A file read was reliable.
  const capturing = (exec: (file: string, args: string[]) => Promise<unknown>) => {
    const files = new Map<string, string>();
    const removed: string[] = [];
    const sprite = {
      execFile: vi.fn(async (file: string, args: string[]) => {
        const dir = args[3] ?? "";
        files.set(`${dir}/out`, "stdout from the file");
        files.set(`${dir}/err`, "stderr from the file");
        return exec(file, args);
      }),
      filesystem: () => ({
        readFile: (path: string) => Promise.resolve(files.get(path) ?? ""),
        rm: (path: string) => {
          removed.push(path);
          return Promise.resolve();
        },
      }),
    } as unknown as Sprite;
    return { handle: wrapSprite(sprite, {} as SpritesClient), sprite, removed };
  };

  it("reads the output from files in the sprite, not from the exec stream, and removes them", async () => {
    const { handle, sprite, removed } = capturing(() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }));
    const result = await handle.execFileCaptured("git", ["diff", "--cached"], options);
    expect(result).toEqual({ exitCode: 0, stdout: "stdout from the file", stderr: "stderr from the file" });
    const [file, args] = (sprite.execFile as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]];
    expect(file).toBe("/bin/sh");
    expect(args.slice(4)).toEqual(["git", "diff", "--cached"]);
    expect(removed).toEqual([args[3]]);
  });

  it("carries a non-zero exit code with the output of the files", async () => {
    const { handle } = capturing(() =>
      Promise.reject(Object.assign(new Error("Command failed with exit code 2"), { exitCode: 2, stdout: "", stderr: "" })),
    );
    await expect(handle.execFileCaptured("git", ["status"], options)).rejects.toMatchObject({
      exitCode: 2,
      stdout: "stdout from the file",
      stderr: "stderr from the file",
    });
  });
});
