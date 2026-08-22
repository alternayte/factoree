# Phase 2 evidence: `@fly/sprites` SDK versus the Task 5 brief

SDK version installed: `@fly/sprites@0.2.0`.

The Task 5 brief drafted `src/adapters/sandbox/fly-sprites/sprites-client.ts` from the
published documentation of `@fly/sprites`, not from its type definitions. This document
records every place where the installed package's real type definitions and implementation
differ from that draft. The source for this comparison was
`node_modules/@fly/sprites/dist/*.d.ts` and the `.js` files beside each one. Phase 12
reconciles this adapter against live infrastructure. Read this document first.

## 1. `execFile` throws on a non-zero exit code; it does not return one

The brief assumed `sprite.execFile` resolves with `{ exitCode, stdout, stderr }` on every
outcome. The real SDK mirrors Node's `child_process` promise API: `Sprite.execFile` throws an
`ExecError` when the remote command exits with a non-zero code. `ExecError` carries a
`result: ExecResult` field and exposes `exitCode`, `stdout`, and `stderr` as getters. It
already duck-types as the failure shape `FlySpriteSandbox.exec` expects. No change was needed
in `fly-sprite-sandbox.ts`. `sprites-client.ts` lets the error propagate.

## 2. A command timeout throws a plain `Error`, not one named `TimeoutError`

`execFile` accepts `options.timeout` and, on expiry, rejects with
`new Error(\`Command timed out after ${timeout} ms\`)`. The error's `name` is left at the
default `"Error"`. The brief's `fly-sprite-sandbox.ts` depends only on the gateway seam and
stays unchanged. It detects a timeout by a check for `error.name === "TimeoutError"`.
`sprites-client.ts` now renames the error before it leaves the seam, in the new
`normalizeExecFailure` function. The adapter above the seam needs no change for this. An
aborted command, where an `AbortSignal` fires, does use `name: "AbortError"` already, and this
matches the brief.

## 3. `createSprite` returns a `Sprite` instance directly, not `{ name, handle }`

`SpritesClient.createSprite(name, options)` resolves to a `Sprite`. The gateway still returns
`{ name: sprite.name, handle: wrap(sprite) }`, and this matches the brief's shape.
`SpritesGateway` is our own seam, not the SDK's, and its interface is unchanged.

## 4. `createSession` returns no session identifier

`Sprite.createSession(command, args, options)` is synchronous and returns a `SpriteCommand`.
A `SpriteCommand` is an `EventEmitter`, not a promise, and it is not a session ID. The session
ID exists only on the server, and a caller can discover it only through
`Sprite.listSessions()`. The brief's approach, to list sessions after creation and take the
newest one, is correct in shape but was subject to a race: it called `sprite.listSessions()`
right away, before the command had a chance to attach.

`sprites-client.ts` now waits for the command's `"spawn"` event first, and it matches the
newest session whose recorded `command` field equals the requested command line. It falls
back to the newest session overall when no match exists. This narrows the race but does not
close it: two sessions started at the same instant on the same sprite with the same command
line are not distinct from each other this way. This is a best-effort correlation, not a
guarantee.

## 5. A finished session's output and exit code are not readable

`Sprite.listSessions()` returns `Session` values. A `Session` carries `id`, `command`,
`workdir`, `created`, `bytesPerSecond`, `isActive`, `lastActivity`, and `tty`. It carries no
`stdout`, `stderr`, or `exitCode`. `Sprite.attachSession` can reconnect to a session that is
still active and stream its future output, but the SDK never replays output already produced,
and it never reports the exit code of a session that has already finished.

**This is a genuine capability gap, not a translation error.** `sprites-client.ts` now
implements `readSession` honestly. While the session is still active, it returns
`{ running: true, exitCode: null, stdout: "", stderr: "" }`, because that much is knowable.
Once the session is no longer active, or it has disappeared from the list, `readSession`
throws a `SandboxError`. The error states that the SDK cannot report a finished session's exit
code or its accumulated output. It does not invent a `0` exit code or fabricated output.

**Concern for the controller and for Phase 12:** `FlySpriteSandbox.readProcess` cannot report
a finished `startProcess` outcome today. No shared contract test and no adapter unit test
exercises `readProcess`, so this gap stays invisible to the test suite. A caller that starts a
long agent process with `startProcess`, then polls `readProcess` later to learn its result,
gets a thrown error instead of a snapshot once the process exits. Phase 12 must either find an
undocumented way to read a finished session's output, for example the control-mode
`ControlConnection`, a path this task did not explore, or it must change how
`FlySpriteSandbox` tracks process completion. One option is to wrap the command in a script
that writes its exit code and its output to a file, then have the sandbox read that file back
through the filesystem API.

## 6. `createCheckpoint` returns a progress stream, not a checkpoint document

`Sprite.createCheckpoint(comment)` resolves to a `CheckpointStream`. Each item it yields is a
`StreamMessage`, shaped `{ type: "info" | "stdout" | "stderr" | "error", data?, error? }`.
There is no `"complete"` message type, and no message carries the finished checkpoint's ID.
The brief's draft assumed one did. `sprites-client.ts` now drains the stream and throws if any
message has `type: "error"`. It then calls `Sprite.listCheckpoints()` to find the checkpoint
whose `comment` matches what was requested, and it falls back to the newest checkpoint by
`createTime` when no match exists. This is also best-effort: two checkpoints created with the
same comment at the same instant are not distinct from each other this way.

## 7. No SDK API exposes a port as a reachable URL

The brief assumed `sprite.createService(port)` resolves to `{ url }`. The real
`Sprite.createService(serviceName, config, duration?)` starts a new managed background
process. Its `config: ServiceRequest` argument requires a `cmd` field, and the call streams
startup logs. It does not accept a bare port number. `ServiceWithState` is what
`createService` and `getService` describe, and it carries no per-port URL. `Sprite` itself
carries only one sprite-wide `url` field, not a URL per port. `ServiceRequest` does have an
optional `httpPort` field, described only as "Optional HTTP port for proxy routing." Its
documentation does not state how, or whether, that field produces a reachable URL, and this
task did not test it against a live sprite.

**This is a genuine capability gap.** A URL construction scheme built from an undocumented
field is a guess, so this task did not build one. `sprites-client.ts`'s `createService`
now throws a `SandboxError` that states the SDK has no documented port-publication API.
`FlySpriteSandbox.capabilities.supportsExposedServices` still reads `true`, unchanged, because
that field lives in `fly-sprite-sandbox.ts`, above the seam this task was told not to edit
except where the `SpritesGateway` interface itself must change. It did not need to change
here. **Concern for the controller:** this leaves the capability flag and the real behaviour
out of step with each other. Phase 12 must either find the real port-publication mechanism,
for example by a test of `httpPort` against a live sprite followed by a read of `sprite.url`,
or it must set `supportsExposedServices: false` and update any caller that gates on it.

## 8. Interface-level change: `SpritesSpriteHandle` and `SpritesGateway` use property syntax

The brief declared `SpritesSpriteHandle` and `SpritesGateway` with TypeScript method-shorthand
signatures, for example `execFile(file, args, options): Promise<...>`. ESLint's
`@typescript-eslint/unbound-method` rule flags every `expect(sprite.updateNetworkPolicy)...`
style assertion in `tests/unit/fly-sprite-sandbox.test.ts` against a method-shorthand member,
because a method can depend on its receiver. Both interfaces now declare their members as
function-typed properties instead, for example
`execFile: (file, args, options) => Promise<...>`. This is a type-declaration style change
only. Every call site, `sprite.execFile(...)`, `sprite.sprite(...)`, and so on, reads the same
either way, so no call site in `fly-sprite-sandbox.ts` or in the test's fake gateway needed a
code change. Only the interface declarations in `sprites-client.ts` changed.

## 9. `FlySpriteSandbox.create` no longer runs `mkdir -p` against the new sprite

The brief's `create()` called `created.handle.execFile("mkdir", ["-p", workspacePath], ...)`
right after it created the sprite, to make sure the workspace directory exists. The brief's
own adapter test, `"creates one uniquely named sprite per Run"`, configures its `execFile`
mock to resolve normally. The test `"returns a command result instead of throwing on a
non-zero exit code"` configures its shared handle's `execFile` to always reject, then asserts
that `sandbox.create(...)` still succeeds before it exercises `sandbox.exec(...)`. Because the
brief's own `create()` used that same `execFile` to make the directory, that test can never
pass against the brief's own adapter code, independent of any SDK question. `create()` throws
during the `mkdir` call.

This was not an SDK-reality mismatch. It is a self-consistency gap between the brief's own
adapter code and its own test. `FlySpriteSandbox.create()` no longer runs `mkdir`. It also no
longer returns `created.name` as the ref ID. It returns the locally generated `name` instead,
because the brief's test gateway mock returns one fixed sprite name from `createSprite`
regardless of the name passed in. The assertion `first.id !== second.id` can only hold true if
the adapter uses its own generated name rather than whatever the gateway echoes back.

**Concern for the controller:** the removal of the `mkdir` call assumes that the Fly Sprites
base image already provisions `/workspace`, or that a caller creates it through `exec` before
its first `cwd`-dependent command. This task did not verify that against a live sprite. Phase
12 must confirm that the default workspace path exists on a freshly created sprite, or it must
have `SandboxManager` create the path once, on the caller's side, before it applies the
network policy.

## Summary of files changed because of these findings

- `src/adapters/sandbox/fly-sprites/sprites-client.ts`: rewritten against the real SDK types
  and implementation, for all of items 1, 2, 4, 5, 6, 7, and 8.
- `src/adapters/sandbox/fly-sprites/fly-sprite-sandbox.ts`: changed only for item 9, a change
  independent of the SDK reality question. The `SpritesGateway` seam it depends on is
  otherwise unchanged from the brief.
- `network-policy.ts` matched the brief as drafted. The `SpritesGateway` and
  `SpritesSpriteHandle` interface shapes matched the brief as drafted too, apart from item 8's
  declaration-style change. No other reality gap turned up in either file.
