# Vercel Sandbox provider

Amends `docs/specs/sandbox-provider-spillover.md` (the provider types), `docs/specs/e2b-sandbox-provider.md` (Out: other adapters), DI-21.02 (Docker) and DI-15.28 (the sandbox size).

## What it does
`vercel` is a sandbox provider type in Settings > Install. Its work sprites and check sprites run as Vercel Sandbox microVMs, built from the Factoree sandbox image. The worker copies that image into the operator's Vercel Container Registry (VCR) project itself. A Vercel provider serves repositories with Docker only when rootless Docker works for `agent` in its template; otherwise selection sends those repositories to another provider. Build-ahead keeps a filesystem warm snapshot of each repository on Vercel.

## Decisions
- The provider settings hold an access token, a team id, a project id and an optional region (default `iad1`) in a typed options field of the provider — the SDK reads no `VERCEL_TOKEN`, and a snapshot and an image belong to one region.
- The adapter uses `@vercel/sandbox`, pinned to an exact version, in `src/adapters/sandbox/vercel` only — AGENTS.md keeps provider SDKs in the adapters.
- At the first create for an image digest, the worker copies the GHCR image into the VCR project through the Registry v2 API, with the team id as user and the token as password, keeps the manifest digest, and waits until VCR reports it Ready — Vercel cannot pull from GHCR, and no operator step must be manual.
- The template name holds the image digest and the vCPUs, as on Kiln — a size change builds a new template.
- The size is the vCPU count only (1 to 8). Memory is 2 GB per vCPU and the disk is a fixed 64 GB, so the form hides the memory field for `vercel` — Vercel fixes both.
- Every command and file write runs as `agent` through `sudo -u agent`, and the sandbox image holds the sudoers entry for it. Only a device or a dockerd step runs as root — B-2 keeps the runner CLIs root-owned.
- `startProcess` starts a detached command, and a later activity reads it by its command id — a process must outlive the client that started it.
- A new sandbox starts with all egress denied. `applyNetworkPolicy` replaces `networkPolicy` with the allow list on each of the three phases. Vercel enforces it outside the guest by SNI on port 443 only, as E2B does on 80 and 443 — git and package managers use HTTPS.
- Once per template, the adapter starts rootless Docker as `agent` with `factoree-docker-start` and runs one container. The result sets `supportsDocker`, and an unchecked template counts as false — rootful Docker would make the agent root in the VM.
- Only build-ahead takes a warm snapshot on Vercel, and a cold run takes none — a Vercel snapshot stops the sandbox it saves.
- A restore holds no running process. Preparation starts dockerd and the compose stack again, as in a cold sandbox — a Vercel snapshot holds the filesystem only.
- The session timeout is the remaining run budget plus 10 minutes, and each call extends it — Vercel stops a session at its timeout.
- When a run ends, its work sprite stops and keeps its files, and the reaper deletes it when retention ends — no session lasts beyond 24 hours.
- `exposeService` adds the port to the sandbox and returns its public URL, which holds the random sandbox id — the check browser holds no Vercel token, as on E2B (DI-14.17).
- `egressLog` is absent, so the setup report names no observed host — Vercel records no hosts, as on E2B.
- A product that holds host credentials is refused on a `vercel` provider with `CONFIGURATION_INVALID` — `docs/specs/host-credentials.md` sets that rule for a provider that binds none.
- The provider form states that the team needs the Pro plan or higher — Hobby stops a session at 45 minutes and allows 10 sandboxes.
- A session that Vercel stops at its timeout during a run fails the run as a provider fault — it is not a repository fault.

## Out
- Rootful Docker on Vercel.
- Memory snapshots and pause with memory.
- Host credential bindings on Vercel.
- Egress on ports other than 443, and git over SSH.
- Daytona. It needs a $500 tier for per-sandbox allow lists, allows 10 GiB of disk, and intercepts TLS.

## How I know it works
- `just verify` passes, and `tests/unit/vercel-sandbox.test.ts` passes against a fake Vercel client.
- Settings > Install adds a Vercel provider with a token, a team id and a project id, and refuses one without them.
- After the first run, the VCR project lists the sandbox image with the digest of the GHCR image.
- A run of a repository without Docker on a Vercel-only product opens a pull request, and its proof pack names the Vercel provider.
- An implementer `curl` to a domain outside the allow list fails inside the Vercel sandbox.
- The provider row shows whether Docker works on its template. A Docker repository on an install with Kiln and Vercel runs on Kiln when the Vercel template has no Docker.
- The second run of a repository restores the warm snapshot that build-ahead took on Vercel.
