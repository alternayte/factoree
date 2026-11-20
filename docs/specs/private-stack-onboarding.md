# Private stack onboarding

Amends `docs/specs/repository-setup-and-services.md`, `docs/specs/host-credentials.md` and `docs/specs/setup-speed-and-history.md`. Closes GitHub issue 59 and supersedes pull request 63. Reference: `docs/factoree-sdd.md` §29.

## What it does
Setup succeeds on the first try on a private repository whose build uses a private registry, private git dependencies and an existing CI workflow. Before the setup agent starts, Factoree reads the hosts that the repository's own files name. The operator adds them all in one step, with a host credential where a host needs one. The setup agent takes the bootstrap and verify commands from the repository's CI workflow first, and the setup report cites where each part came from. The setup proof then restores a snapshot of its own sandbox and runs the bootstrap again exactly as a run does. A bootstrap that passes setup therefore passes the first run. Egress stays denied in every phase, and a sandbox reaches public-internet hosts only.

## Decisions
- Egress stays an exact-name allow list in every phase, setup and bootstrap included. No phase gets open or recorded egress — the agent writes the bootstrap command, so an open proof is a path for private source to leave (SDD §29).
- Before the setup session, Factoree reads the default-branch files through the GitHub App and lists their hosts as derived hosts:
  - registry config: `.npmrc`, `.yarnrc.yml`, `NuGet.config`, `pip.conf`, `pyproject.toml` and `poetry.lock` sources, `Pipfile.lock` sources, Maven `settings.xml` and `pom.xml` repositories, Gradle repositories, `.cargo/config.toml`, and Go `GOPRIVATE` and `GOPROXY`
  - the resolved URLs in `package-lock.json`, `yarn.lock` and `pnpm-lock.yaml`, except the default public registry
  - git dependencies in the manifests and lockfiles
  - the registry URLs in `.github/workflows/*.yml`, such as `registry-url` and `NUGET_SOURCE`
  - Committed files decide the hosts with no agent and no sandbox, so they hold before the first proof.
- A derived host that the ecosystem host list, the product allow list or a host credential already covers needs nothing. Each other derived host shows on the setup start form and in the setup report, with "Add to product allow list" and "Add host credential". The host credential form opens with the host filled in — the product owns its egress ceiling (R-4), and one form for all hosts replaces one failed setup run per host.
- "Add all" adds every listed derived host to the product allow list in one step.
- A derived host on `github.com` for a repository of the installation goes to the product's `github` host credential list instead — `host-credentials.md` already covers git dependencies.
- At preparation, a derived host or a credential host that does not resolve, or that resolves to a private, loopback or link-local address, fails with `CONFIGURATION_INVALID`. The message says that sandboxes reach public-internet hosts only. It names the host and recommends a reachable registry: GitHub Packages of the organization, a cloud feed such as Azure Artifacts or JFrog Cloud, or an internet-facing proxy with a host credential — Kiln refuses private addresses (Kiln `egress-guard.md`), and E2B BYOP needs a public proxy.
- The setup prompt tells the agent to take the commands in this order:
  1. the CI workflows in `.github/workflows`
  2. `.devcontainer/devcontainer.json` and its features and `postCreateCommand`
  3. the Dockerfile
  4. the task runner: `Makefile`, `justfile`, `package.json` scripts, `Taskfile.yml`

  It invents a command only when none of these holds one — the CI workflow is the build the customer knows passes.
- Each part of the setup report cites its source as a file and a step, or as "none". A CI step that needs what a sandbox lacks, such as a cloud login, a secret or a self-hosted runner, goes into the report as an app change or as a missing test secret — the operator sees why a CI step is not in the config.
- The setup proof runs the bootstrap through the same `bootstrapScript` as `sandbox-manager.ts`, with the same environment and the same phase egress. One bootstrap timeout applies to both, `BOOTSTRAP_TIMEOUT_MS` = 30 minutes — a bootstrap that passes in one and fails in the other is the #59 fault, and a run bootstrap with no timeout hangs until the prepare activity times out.
- After the cold proof of the bootstrap and the warm command, setup takes a snapshot of the proof sandbox on the product's provider and restores it in a new sandbox. In the restored sandbox it checks out the head SHA again, applies the bootstrap-phase egress, runs the bootstrap, and starts the services, as a work sprite does. Then it deletes the snapshot — build-ahead stays the only source of warm snapshots.
- A failure in the restored sandbox fails the bootstrap part with "The bootstrap failed after a warm restore", the output tail, and the egress facts — the operator fixes it before the setup PR merges.
- A provider with no warm snapshots skips the warm proof, and the report says so — the run on that provider starts cold anyway.
- The setup prompt explains that the bootstrap runs again in every sandbox restored from a warm snapshot and must pass from the caches, and what `warm.command` is for — from issue 59 and pull request 63.
- E2B records no egress log, so on E2B the denied hosts of a failed part come from the output tail as host hints — the derived hosts already cover the private hosts before the first proof.
- The derived hosts and the warm proof time are stored on the setup row and shown on the setup history page — a slower setup shows its cause.

## Out
- Open or recorded egress in any phase, and Kiln observe mode.
- Reaching hosts inside the customer's private network: a private host allow list in Kiln, a corporate CA, a VPN, and E2B BYOP.
- Parsing GitHub Actions into config deterministically, and running CI jobs in the sandbox.
- A retry or a cold fallback after a failed bootstrap in a run.
- Heartbeats of the setup and verify activities (#54) and expand-and-contract migrations (#55).

## How I know it works
- Start a setup on a repository whose `.npmrc` names a private `npm.pkg.github.com` scope. The start form lists `npm.pkg.github.com` before the agent starts, and "Add host credential" opens with that host filled in.
- After the host credential is added, the setup proves the bootstrap in one setup run, and the report cites `.github/workflows/<file>` for the bootstrap and verify parts.
- A setup whose bootstrap downloads from a host that is reachable cold but not after a restore fails the bootstrap part with "The bootstrap failed after a warm restore".
- The c-dash setup on Kiln passes with the warm proof, and the setup history shows the warm proof time.
- A host credential for a host that resolves to `10.0.0.5` fails preparation with `CONFIGURATION_INVALID`, and the message names the host and the reachable registry options.
- `just verify` passes.
