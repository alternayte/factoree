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
still active. It can stream that session's future output. The SDK never replays output
already produced. It never reports the exit code of a session that has already finished.
This remains a genuine SDK gap, not a translation error. No documented, undocumented, or
control-mode API call reads a finished session's exit code or its accumulated output.

**Fix round 1 closed this gap with a shell wrapper.** It is built entirely from documented
SDK calls. `FlySpriteSandbox.startProcess` no longer asks the SDK to identify the process it
starts. Instead:

- It generates its own identifier, `proc-<8 hex characters>`, from `randomUUID()`, and
  computes a per-process directory inside the sandbox, `<workspacePath>/.factoree/proc/<id>`.
- `startProcess` creates that directory itself, with a blocking `execFile("mkdir", ["-p",
  dir], ...)` call, before it starts anything. This makes the directory's presence a reliable
  signal that Factoree issued this identifier, not merely that the wrapper has run.
- It builds a wrapper script and starts it through `SpritesGateway.startDetached`. Round 1's
  evidence stated that `startDetached` passes `detachable: true` to `Sprite.createSession`
  itself. That credited the wrong code. `startDetached` passes only `cwd` and `env`.
  `Sprite.createSession` forces `detachable: true` on every call, on the SDK's own side, seen
  directly in `sprite.js`. The behaviour round 1 described was correct. The code credited for
  it was not.
- The wrapper runs under `sh -c`. It receives the real command as positional parameters,
  `"$@"`, rather than as text folded into the script. The caller's file and arguments stay
  intact this way, and the shell never splits them apart again. Before it backgrounds the
  real command, it checks for a `cancel` marker file, described below, and stops there if the
  marker is present. Otherwise it backgrounds the real command, with standard output sent to
  an `out` file and standard error sent to an `err` file. It records the backgrounded job's
  process group leader to a `pid` file the moment the job starts. It waits for the command,
  then writes its numeric exit code to an `exit` file last. The `exit` file's presence is the
  signal that the process finished. No session field reports it, so nothing else can serve as
  that signal.
- `startProcess` returns `{ id }` with the identifier Factoree generated. It does not touch
  the SDK's session ID at all.
- `readProcess` first checks whether the process directory exists. An identifier whose
  directory is absent throws a `SandboxError` naming it. This is a round 2 fix, recorded in
  item 3 below, in place of a report of `running: true` forever. Once the directory is
  confirmed, it reads the three files back with `exec`, through `sh -c` scripts of the form
  `if [ -f PATH ]; then cat PATH; fi`. A file that does not exist yet produces empty output
  this way, rather than an error. When the `exit` file is absent, the process is running, and
  `readProcess` reports `exitCode: null`. When it is present, `readProcess` parses its
  contents as the exit code. It returns whatever `out` and `err` hold either way, so a caller
  can watch progress before the process finishes.
- `cancelProcess` first checks the process directory. An absent directory means the
  identifier was never issued, or the sandbox is already gone, and the method returns without
  an error. Otherwise it writes a `cancel` marker file, a round 2 fix recorded in item 1
  below, that the wrapper checks before it launches anything. It then rereads the `pid` file,
  up to five times, forty milliseconds apart, before it gives up. Once a pid is read, it
  sends `SIGTERM` to the negative of that process ID, the process group, so a child the
  wrapped command spawned is terminated with it. A direct `kill` of the same ID is the
  fallback, used when the process-group form is rejected. The whole call sits inside a catch
  that never rethrows. Cancellation of a process that has already gone stays idempotent this
  way, matching `destroy`.

This scheme uses only `execFile` and `startDetached`, both documented SDK calls. It needs no
control-mode `ControlConnection`. It needs no filesystem API beyond what `exec` already
provides through shell redirection.

`tests/unit/fly-sprite-sandbox.test.ts` covers seven cases: a running process; a finished
process with a zero exit code; a finished process with a non-zero exit code; an unissued
identifier, which throws instead of a poll that never ends; a cancel of a running process; a
cancel that still terminates a process which starts during the cancel window; and a cancel of
an identifier that was never issued.

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
Phase 7 or Phase 12 flips the flag back to `true` once the real port-publication mechanism is
proved against a live sprite, for example by a test of `httpPort` followed by a read of
`sprite.url`. `tests/unit/fly-sprite-sandbox.test.ts` asserts the flag reads `false`.

**Fix round 1 left a contradiction that fix round 2 closed.** `exposeService` still called
through to the gateway and returned whatever URL it yielded. A gateway other than the
production seam, including the test's own fake, can therefore make `exposeService` return a
URL. `capabilities.supportsExposedServices` reported `false` at the same time.
`FlySpriteSandbox.exposeService` now throws a `SandboxError` itself, before it ever reaches a
gateway. `createService` is removed from `SpritesSpriteHandle` and from the seam entirely,
since nothing calls it any more. `tests/unit/fly-sprite-sandbox.test.ts` asserts the rejection
and checks that its message names the port.

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

Ruling 1 addressed the `readProcess` gap, item 5. Ruling 2 addressed the capability flag,
item 7. Both are resolved in code, covered by unit tests, and recorded above. Ruling 3
required no code change. Item 9 records that a later task gives `SandboxManager` ownership of
the workspace directory. Item 6, the checkpoint correlation, stays as originally documented,
out of scope for that round by explicit instruction.

## Fix round 2 status

A task review confirmed the shell quoting, the SDK confinement to the seam, the deny-all
policy, and three evidence claims from round 1. It found three behavioural defects.

- **Finding 1 (Important), the `cancelProcess` start-window gap.** `cancelProcess` returned
  silently when a cancel arrived before the wrapper had written its `pid` file. A stop signal
  issued in the first moments of a Run left the process alive. SDD section 50 requires a
  stop signal to terminate the active process, and acceptance test AT-31 proves it. Item 5
  above now records the fix: a cancel marker the wrapper checks before it launches anything,
  plus a bounded reread of the `pid` file. One open window remains, between the wrapper's
  marker check and its `pid` write. Both are local shell steps, with no network round trip
  between them. This narrows the window close to zero. It does not prove the window closed,
  since no lock enforces it. `tests/unit/fly-sprite-sandbox.test.ts` proves a cancel issued
  before the `pid` file exists still terminates the process, through a fake whose `pid` file
  appears mid-retry.
- **Finding 2 (Important), `exposeService` threw only inside the seam.** Item 7 above
  records this fix: `exposeService` now throws a `SandboxError` itself. `createService` is
  gone from the seam.
- **Finding 3 (Minor, promoted), an unknown process identifier polled forever.** Item 5 above
  records this fix: `readProcess` now throws a `SandboxError` that names the identifier, when
  its process directory does not exist. This matches `LocalProcessSandbox`.

Three further fixes rode along in the same files:

- `sprites-client.ts`'s `normalizeExecFailure` now coerces a non-zero exit failure's `stdout`
  and `stderr` to a string on the failure path. The success path already did this. `ExecResult`
  permits a `Buffer` for either field; without this fix, one turns silently into an empty
  string.
- `fly-sprite-sandbox.ts` now uses `posix.join` and `posix.isAbsolute` everywhere it builds or
  resolves a path, such as `resolveCwd`, which used the platform `join` and `isAbsolute`
  before. Every path in this file addresses a remote POSIX filesystem, regardless of the host
  platform this code runs on.
- The kill script's process-group signal and its direct-pid signal are now joined with `||`.
  The direct signal fires only when the process-group signal is rejected. This matches what
  item 5 already described as a fallback.

`tests/unit/fly-sprite-sandbox.test.ts` also gained the three assertions the review named. A
command's `timeoutMs` reaches the gateway as `timeout` on `exec`. `startProcess` never passes
a `timeout`, since `startProcess` ignores it by contract. `exposeService` rejects.

### Open questions for Phase 12

- Whether a detached session survives `command.close()` when `maxRunAfterDisconnect` is left
  unset. If the server's default kills a session on client disconnect, every process this
  adapter starts dies immediately, and only a live sprite can settle this.
- Whether `set -m` reliably gives the backgrounded command its own process group, across
  every shell the Fly Sprites base image can run. `cancelProcess`'s process-group kill depends
  on this.
- What `ramMB`, `cpus`, and `storageGB` a Run needs by default. `FlySpriteSandboxOptions.config`
  currently passes on whatever the caller supplies, with no resource guidance of its own.
