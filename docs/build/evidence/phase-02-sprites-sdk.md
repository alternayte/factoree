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

## 4. `createSession` returns no session identifier — RESOLVED

`Sprite.createSession(command, args, options)` is synchronous and returns a `SpriteCommand`.
A `SpriteCommand` is an `EventEmitter`, not a promise, and it is not a session ID. The session
ID exists only on the server, and a caller can discover it only through
`Sprite.listSessions()`.

The first draft of `sprites-client.ts` waited for the command's `"spawn"` event, then matched
the newest session whose recorded `command` field equalled the requested command line. This
was a best-effort correlation, not a guarantee, because two sessions started at the same
instant on the same sprite with the same command line are not distinct from each other this
way.

**Fix round 1 removed this correlation entirely.** `FlySpriteSandbox.startProcess` now
generates its own process identifier, for example `proc-a1b2c3d4`, rather than a request to
the SDK for one. `SpritesGateway`'s `startDetached` method fires the wrapper script through
`Sprite.createSession` and returns nothing; nothing downstream needs a session ID any more.
See item 5 for the full scheme. This item is resolved. It is kept in this document, rather
than deleted, as a record of the SDK behaviour that made the fix necessary.

## 5. A finished session's output and exit code are not readable — RESOLVED with a wrapper

`Sprite.listSessions()` returns `Session` values. A `Session` carries `id`, `command`,
`workdir`, `created`, `bytesPerSecond`, `isActive`, `lastActivity`, and `tty`. It carries no
`stdout`, `stderr`, or `exitCode`. `Sprite.attachSession` can reconnect to a session that is
still active and stream its future output, but the SDK never replays output already produced,
and it never reports the exit code of a session that has already finished. This remains a
genuine SDK gap, not a translation error: no documented, undocumented, or control-mode API
call reads a finished session's exit code or its accumulated output.

**Fix round 1 closes this gap with a shell wrapper, built entirely from documented SDK
calls.** `FlySpriteSandbox.startProcess` no longer asks the SDK to identify the process it
starts. Instead:

- It generates its own identifier, `proc-<8 hex characters>`, from `randomUUID()`.
- It computes a per-process directory inside the sandbox,
  `<workspacePath>/.factoree/proc/<id>`.
- It builds a wrapper script and starts it through `SpritesGateway.startDetached`, which calls
  `Sprite.createSession` with `detachable: true` under the hood. The wrapper runs under `sh -c`
  and receives the real command as positional parameters, `"$@"`, rather than as text folded
  into the script, so the caller's file and arguments stay intact and the shell never splits
  them apart again. It creates the process directory, backgrounds the real command with standard output
  sent to an `out` file and standard error sent to an `err` file, records the backgrounded
  job's process group leader to a `pid` file the moment the job starts, waits for the command,
  and writes its numeric exit code to an `exit` file last. The `exit` file's presence is the
  signal that the process finished; no session field reports it, so nothing else can serve
  as that signal.
- `startProcess` returns `{ id }` with the identifier Factoree generated. It does not touch
  the SDK's session ID at all.
- `readProcess` reads the three files back with `exec`, through `sh -c` scripts of the form
  `if [ -f PATH ]; then cat PATH; fi`, so a file that does not exist yet produces empty output
  rather than an error. When the `exit` file is absent, the process is running, and
  `readProcess` reports `exitCode: null`. When it is present, `readProcess` parses its
  contents as the exit code. It returns whatever `out` and `err` hold either way, so a caller
  can watch progress before the process finishes.
- `cancelProcess` reads the `pid` file. An identifier that was never issued, or one whose pid
  file was never written, has nothing to cancel, and `cancelProcess` returns without an error.
  Otherwise, it sends `SIGTERM` to the negative of that process ID, the process group, so a
  child the wrapped command spawned is terminated along with it, and falls back to a direct
  `kill` of the same ID if the process-group form is rejected. The whole call is wrapped in a
  catch that never rethrows, so cancellation of a process that has already gone stays
  idempotent, matching `destroy`.

This scheme uses only `execFile` and `startDetached` (`Sprite.createSession` underneath),
both documented SDK calls; it needs no control-mode `ControlConnection` and no filesystem API
beyond what `exec` already provides through shell redirection. `tests/unit/fly-sprite-sandbox.
test.ts` covers a running process, where the `exit` file is absent, a finished process with a
zero exit code, a finished process with a non-zero exit code, and a cancel that does not throw
for an identifier that was never issued.

## 6. `createCheckpoint` returns a progress stream, not a checkpoint document

`Sprite.createCheckpoint(comment)` resolves to a `CheckpointStream`. Each item it yields is a
`StreamMessage`, shaped `{ type: "info" | "stdout" | "stderr" | "error", data?, error? }`.
There is no `"complete"` message type, and no message carries the finished checkpoint's ID.
The brief's draft assumed one did. `sprites-client.ts` now drains the stream and throws if any
message has `type: "error"`. It then calls `Sprite.listCheckpoints()` to find the checkpoint
whose `comment` matches what was requested, and it falls back to the newest checkpoint by
`createTime` when no match exists. This is also best-effort: two checkpoints created with the
same comment at the same instant are not distinct from each other this way.

## 7. No SDK API exposes a port as a reachable URL — capability flag now honest

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
field is a guess, so this task did not build one. `sprites-client.ts`'s `createService` still
throws a `SandboxError` that states the SDK has no documented port-publication API.

**Fix round 1 changed `FlySpriteSandbox.capabilities.supportsExposedServices` to `false`.** A
flag that claims a capability the adapter does not have is worse than an honest `false`.
Nothing calls `exposeService` before Phase 7, so this has no caller to update today. Phase 7
or Phase 12 flips the flag back to `true` once the real port-publication mechanism is proved
against a live sprite, for example by a test of `httpPort` followed by a read of `sprite.url`.
`tests/unit/fly-sprite-sandbox.test.ts` now asserts the flag reads `false`.

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

**Concern for the controller, resolved by ruling:** the removal of the `mkdir` call assumes
that the Fly Sprites base image already provisions `/workspace`, or that a caller creates it
through `exec` before its first `cwd`-dependent command. This task did not verify that
against a live sprite. A later task makes `SandboxManager` create the workspace directory
itself, right after it applies the network policy and before any checkout, so this adapter
does not need to act on this concern. `FlySpriteSandbox` correctly leaves the workspace
directory as the caller's responsibility.

## Summary of files changed because of these findings

- `src/adapters/sandbox/fly-sprites/sprites-client.ts`: rewritten against the real SDK types
  and implementation, for all of items 1, 2, 4, 5, 6, 7, and 8. Fix round 1 replaced
  `createSession`/`readSession`/`killSession` with a single `startDetached` method, since
  `FlySpriteSandbox` no longer needs the SDK to identify or read back a session.
- `src/adapters/sandbox/fly-sprites/fly-sprite-sandbox.ts`: changed for item 9, a change
  independent of the SDK reality question, and by fix round 1 for items 4, 5, and 7:
  `startProcess`, `readProcess`, and `cancelProcess` now use the file-backed wrapper scheme,
  and `capabilities.supportsExposedServices` now reads `false`.
- `network-policy.ts` matched the brief as drafted. The `SpritesGateway` and
  `SpritesSpriteHandle` interface shapes matched the brief as drafted too, apart from item 8's
  declaration-style change and fix round 1's `startDetached` change. No other reality gap
  turned up in either file.

## Fix round 1 status

Ruling 1 (item 5, the `readProcess` gap) and ruling 2 (item 7, the capability flag) are both
resolved in code, covered by new unit tests, and recorded above. Ruling 3 required no code
change; item 9 now records that a later task gives `SandboxManager` ownership of the workspace
directory. Item 6, the checkpoint correlation, stays as originally documented, out of scope
for this round by explicit instruction.
