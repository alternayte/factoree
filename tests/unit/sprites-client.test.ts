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
