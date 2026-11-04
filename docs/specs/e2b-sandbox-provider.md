# E2B sandbox provider

Amends `docs/specs/kiln-sandbox-provider.md` (Out: the E2B adapter). Amends `docs/factoree-sdd.md` §31 and §32.

## What it does
`e2b` is a fourth sandbox provider in the install settings. The work sprite and every check sprite then run as E2B sandboxes, built from the Factoree sandbox image. A warm snapshot per repository skips most of the clone and bootstrap time, as on Kiln. Fly Sprites stays the default. A switch between the providers breaks no run that has started.

## Decisions
- E2B is one more value of the install setting `sandbox.provider`, chosen once per install. A choice per product stays out of scope, as on Kiln.
- The adapter uses the `e2b` npm SDK, pinned to an exact version. The SDK lives in `src/adapters/sandbox/e2b` only, as AGENTS.md requires for provider SDKs.
- The E2B API key goes in the setting `sandbox.apiKey`. The setting `sandbox.url` holds the URL of a self-hosted E2B, and its host name is the E2B domain. Null means `e2b.app`. The adapter needs no other credential.
- The adapter builds one E2B template per image digest and size, named as on Kiln. A template starts `fromImage` with the image by digest, with the registry login when the settings hold one. A size change builds a new template, and runs that already started keep the old one.
- Each worker builds the template once, at its first create. E2B caches each build step, so a build of an unchanged image is fast. The SDK cannot delete a template, so a failed build must not stay as the state that later runs read.
- `supportsCustomImage` is true. The runner CLIs stay root-owned in `/opt/factoree/bin`, and every command and file write runs as the `agent` user of the image (B-2).
- The sizes `sandbox.vcpus` and `sandbox.memoryMb` apply to E2B as they apply to Kiln. The E2B plan fixes the disk size, so the adapter sends none.
- A new sandbox starts with all egress denied. `applyNetworkPolicy` calls `updateNetwork` with all traffic denied and the allow list allowed. E2B enforces the list at its proxy, outside the guest (SDD §29).
- E2B filters a domain on ports 80 and 443 only, by Host header and by SNI. Every other port stays denied. Git and every package manager use HTTPS, so a run needs no other port.
- When the allow list names a domain, E2B also allows `8.8.8.8` for DNS. The run accepts that resolver. Kiln and Sprites also resolve through a public resolver.
- `startProcess` runs a shell wrapper in the background. The wrapper writes the pid, the output, the error output and the exit code to files, as the Sprites adapter does (DI-2.10). E2B streams the output of a process only to the client that started it, and a process that a later activity reads must outlive that client.
- `exec` runs in the foreground with the command timeout. A non-zero exit code is a result, not a fault.
- A sandbox times out after ten minutes without a call, and E2B then pauses it with its memory. Each call from Factoree extends the timeout. A paused sandbox resumes on the next call. A work sprite never pauses while an agent runs, because the runner reads its process at least once each minute.
- A warm snapshot is an E2B snapshot with memory. A restore creates a new sandbox from the snapshot, with the run metadata of the new run. A snapshot that E2B does not find counts as removed.
- `exposeService` returns `https://` plus the E2B host of the port. The sandbox allows public traffic, so the browser on the worker holds no E2B key (DI-14.17). The host holds the random sandbox id.
- `checkpoint` stays unsupported, as on Kiln. Warm snapshots use `warmSnapshots`.
- The worker installs no browser tools on E2B, because the image holds them.

## Out
- A provider choice per product or per repository.
- A run of `just live` against E2B in this change. It needs an E2B account. The `full` live profile accepts E2B.
- Egress on ports other than 80 and 443.
- Adapters for Daytona, Modal or Northflank.

## How I know it works
- `just verify` passes, and `tests/unit/e2b-sandbox.test.ts` passes against a fake E2B client.
- Settings > Install offers E2B. It refuses to save E2B without an API key.
- With E2B in Settings > Install, an E2B API key and a pushed sandbox image, `just live` opens a pull request, and the run log names the image digest.
- An implementer `curl` to a domain outside the allow list fails inside the E2B sandbox.
- The second run of the same repository restores the warm snapshot.
