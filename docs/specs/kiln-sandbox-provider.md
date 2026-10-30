# Kiln sandbox provider

Amends `docs/factoree-sdd.md` §31, §32 and §52, and `docs/specs/check-isolation.md`. Closes B-2 on Kiln.

## What it does
`SANDBOX_ADAPTER=kiln` runs the work sprite and every check sprite as Kiln microVMs, built from one Factoree sandbox image. The image holds the agent CLIs and the browser tools, so a run installs nothing. A warm snapshot per repository skips most of the clone and bootstrap time. Fly Sprites stays the default, and a switch between the adapters breaks nothing.

## Decisions
- Kiln is a third `SANDBOX_ADAPTER` value, chosen once per install — a choice per product adds routing and secrets per provider before any need exists.
- Fly Sprites stays the default until the Kiln adapter passes `just live` — Sprites is the proven path.
- `SandboxCapabilities` gains `supportsCustomImage` — Factoree must know whether the image holds the tools.
- When `supportsCustomImage` is false, Factoree installs opencode, agent-browser and chrome-headless-shell at run time, as today. B-2 stays open on that adapter, and the run records it — a provider without custom images still runs every feature.
- `sandbox/Dockerfile` in this repository builds the Factoree sandbox image: Node 24, git, opencode, agent-browser and chrome-headless-shell, with the runner CLIs root-owned in `/opt/factoree/bin`. Agents run as a non-root user — the image changes only through a reviewed commit, and an agent cannot replace a runner CLI (B-2).
- CI publishes the image to ghcr.io. `KILN_IMAGE` names it by digest — every run records the exact toolchain it used.
- Factoree creates one Kiln template per image digest when it first needs one, and reuses it for every run — a template build is slow, and one digest needs one build.
- Factoree uses its own Kiln tenant and API key (`KILN_URL`, `KILN_API_KEY`), separate from the pull request preview tenant — caps and registry credentials of one use must not affect the other.
- Factoree takes a warm snapshot right after the clone and bootstrap of a new sandbox, before any agent runs. The key is the repository, the image digest and the SHA of `.factoree/config.yaml` — nothing an agent did can reach a later run or a check.
- A run forks the warm snapshot, fetches and checks out its base SHA, and runs the bootstrap again. A check sprite forks the same snapshot — the dependencies are already in place, so the bootstrap is fast.
- A change of the image digest or of the config SHA makes a new snapshot on the next run — the old snapshot holds an old toolchain or an old bootstrap.
- `applyNetworkPolicy` maps to a runtime egress change on the sandbox, and `startProcess`, `readProcess` and `cancelProcess` map to detached processes. Both come from alternayte/kiln#16 — Factoree changes the allow list three times per run, and the runners are long-running processes.
- `exposeService` maps to Kiln publish with a public, unguessable hostname — the browser on the worker must not hold the Kiln key (DI-14.17).
- A work sprite never sleeps while an agent process runs — an idle pause would stop a run.
- The Sprites adapter keeps its behaviour and takes no warm snapshot — Sprites cannot fork a checkpoint into a new sprite.

## Out
- A provider choice per product or per repository.
- Adapters for E2B, Daytona, Modal or Northflank.
- Warm snapshots on Fly Sprites.
- A Kiln change other than alternayte/kiln#16.

## How I know it works
- `SANDBOX_ADAPTER=kiln just live` opens a pull request, and the run log names the Kiln image digest.
- The second run of the same repository forks the warm snapshot, and its log shows no opencode install.
- An implementer `curl` to a domain outside the allow list fails inside the Kiln sandbox.
- An agent write to `/opt/factoree/bin/opencode` fails with a permission error.
- `SANDBOX_ADAPTER=fly-sprites just live` still passes with the same Factoree build, and the run records B-2 as open.
- A change to `.factoree/config.yaml` makes a new warm snapshot on the next run.
