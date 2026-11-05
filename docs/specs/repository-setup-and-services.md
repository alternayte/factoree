# Repository setup and services

Amends `docs/factoree-sdd.md` §15, §30, §35, §36 and §37, `docs/specs/run-speed.md`, `docs/specs/check-isolation.md` and `docs/specs/proof-pack-and-visual-evidence.md`. Closes #14, #17, #18 and #19.

## What it does
An operator picks a repository and a product on the product page and starts a setup run. A fresh setup agent reads the repository and writes `.factoree/config.yaml` with its toolchains, services, seed, fakes, preview and accounts. Factoree proves each part in a sandbox and opens a pull request with the parts that passed and a report of the parts that did not. After the merge, every work sprite and check sprite starts from a warm snapshot with the toolchains installed and the compose stack running and seeded, and a browser assertion can start signed in as a named account.

## Decisions
- Kiln and E2B run Docker. Fly Sprites and the local adapter declare `supportsDocker: false`, and a repository with `services` fails at preparation on them — a Fly checkpoint keeps no process.
- Docker is rootless, as `agent`, with no rootful fallback — a root socket lets patched test code replace the root-owned runner CLIs and forge a verdict (B-2).
- The sandbox image adds rootless Docker, Docker Compose, `uidmap`, `slirp4netns` and mise, all root-owned — one image serves the Kiln and E2B templates.
- Docker stores its data with overlay2 on the ext4 path when Kiln offers one, else with vfs — fuse-overlayfs started no container in a nested test, and vfs runs everywhere.
- Kiln mounts cgroup2 at `/sys/fs/cgroup` in kilninit and offers an ext4 path for the Docker data directory, through alternayte/kiln#22 and alternayte/kiln#23 — the kernel holds every other feature, and `agent` cannot mount cgroup2.
- A repository installs a toolchain with `mise install` in its bootstrap — mise covers most stacks, and a per-repository image would break B-2.
- `bootstrap.keyFiles` lists files whose content hash joins the bootstrap key, with the compose files and `.factoree/**` always in it — a lockfile or toolchain change starts a build-ahead, so the bootstrap in each fork stays a no-op.
- A `services` block names the compose file, profiles, `seed` and `waitTimeoutSeconds`. Factoree runs `docker compose -f <repository file> -f .factoree/compose.yaml up -d --wait`, then `seed` — Factoree knows when the stack is healthy and can read its labels.
- The stack starts in the warm phase before the snapshot, and `compose up -d --wait` runs again after each restore and in each check sprite — every fork starts with running, seeded services of its own.
- A provider on which a stack does not survive a restore starts the stack in each sprite and records the stage time — a slow start must never fail a run.
- Factoree exports `DOCKER_HOST` and `TESTCONTAINERS_RYUK_DISABLED=true` — Testcontainers then works, and the sandbox is destroyed anyway.
- An external API uses the real host when the product holds a test secret for it, else a WireMock fake in `.factoree/compose.yaml` labelled `factoree.fake: "<name>"` — setup never waits for a key.
- The proof pack lists each fake, and the validator prompt names each faked API — a reviewer must know which data was not real.
- `accounts` names each account with plain-text local credentials, sign-in steps and a signed-in check. The seed creates the accounts through the app's own path — the sandbox database is local, so the passwords are no secrets.
- Factoree signs in each account once per check sprite and keeps the Playwright storage state. A browser entry with `"as": "<account>"` starts signed in, and an entry without it starts anonymous — a sign-in fault becomes one clear failure, not a repair.
- A setup run starts only from the product page or `POST /admin/repositories/:name/setup`, with a product the operator picks — an agent cannot know which product owns a repository.
- A delegated issue in a team whose product has no repository replies with a link to the product page — it replaces an empty target question.
- `setup` is a new agent role with its own runner, model and effort on the product, defaulting to the implementer's — usage and tuning stay per role.
- The setup action policy writes `.factoree/**` only, and Factoree refuses a setup patch that touches another path — the review stays small and plainly Factoree's.
- The setup sandbox uses a fixed ecosystem host list in Factoree's code, and reads the Kiln egress log for the hosts it reached and was denied — nobody writes an allow list by hand, and Kiln observe mode would open every host.
- `bootstrap.allowedDomains` holds the ecosystem hosts the bootstrap reached on Kiln, or the whole ecosystem list on E2B. Factoree accepts only ecosystem hosts there, and they join the bootstrap phase and never the agent phase — the product ceiling stays the agents' limit, and a registry accepts uploads (alternayte/kiln#24).
- Factoree proves each part in a fresh sandbox with only the proposed allow list: bootstrap, each verify command, services and seed, preview readiness, and each account sign-in — the config is tested data, not an agent claim.
- The pull request holds only the parts that passed, and the report names each failed part with its reason. A failed bootstrap opens no pull request — a partial config still gives runs what works.
- A part that needs an app change fails, and the report names the change — a normal issue then implements it.
- A denied host outside the ecosystem list shows "Add to product allow list" on the setup report, and setup runs again — the one manual step happens once per host.
- Each setup run is its own background workflow. Setups run in parallel, one per repository, share `sandboxMaxLive` behind runs, and do not count toward `maxConcurrentRuns` — setup never delays a Linear run.
- A failed build-ahead marks the repository "Needs setup" on the product page with the failure and offers "Run setup again", which opens an update pull request — nothing starts a setup run by itself.
- A hand-written config stays valid, and every new block is optional — no existing repository must run setup.

## Out
- Rootful Docker, a services VM, provider-side services and Podman.
- A per-repository sandbox image, a devcontainer and Nix.
- Run-time detection of toolchains or package managers.
- Record and replay of an external API.
- A sign-in bypass in app code, and MFA or CAPTCHA automation.
- A setup run started by itself, on App install or on drift.
- A private registry login inside the sandbox.

## How I know it works
- A setup run on alternayte/anthology opens a pull request that changes only `.factoree/**`, with a report that names each part as proven or failed and the TMDB fake.
- After the merge, a Linear issue on an anthology page runs on Kiln to READY_FOR_HUMAN, and its proof pack shows a screenshot of seeded data while signed in and names the TMDB fake.
- The `prepare_check_sprite` stage of that run starts from the warm snapshot with the stack running, and its time is recorded in the handover.
- A change to anthology's `packages.lock.json` starts a build-ahead, and the next run's bootstrap does no restore.
- A c-dash run with its existing config reaches READY_FOR_HUMAN on Kiln.
- Factoree's own `npm run test:integration` passes in a Kiln check sprite.
- A setup patch that touches a path outside `.factoree/` is refused.
- A `services` block on Fly Sprites fails at preparation with a message that names the provider.
- The anthology setup and run on E2B pass. BLOCKED_EXTERNAL until an E2B account exists.
- `just verify` passes.
