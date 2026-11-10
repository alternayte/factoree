# Changelog

All notable changes to Factoree are in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Factoree uses [Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version can break compatibility.

## [Unreleased]

## [0.7.3] - 2026-11-10

### Fixed

- Docker uses overlay2 in an E2B sandbox, whose root is ext4. vfs filled the 13 GB disk with the images of one compose stack (DI-21.31).

### Changed

- A reply after a configuration failure starts a follow-up run. The failure post asks for the repair of the configuration or the sandbox first (DI-21.32).

## [0.7.2] - 2026-11-10

### Fixed

- A container starts under rootless Docker in an E2B sandbox. `factoree-docker-start` sets the cgroupfs driver, so dockerd uses no cgroup, as on Kiln. The sandbox image masks the root Docker and containerd services that systemd started in an E2B guest (DI-21.30).

## [0.7.1] - 2026-11-10

### Fixed

- Rootless Docker starts in an E2B sandbox. The adapter opens `/dev/net/tun` and `/dev/fuse` as root after each create and restore, as Kiln does in its guest (DI-21.29).

## [0.7.0] - 2026-11-10

### Added

- Claude Code is a runner. A Product selects the runner, the model and the effort of each role, with a default and a per-role override. The sandbox image holds Claude Code 2.1.319, root-owned, with updates and telemetry off. A claude role needs the runner credential `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, and its API host joins the agent-phase allow list (DI-21.24 to DI-21.26).
- The product page shows one row per role and a model picker: the runner, a searchable model list from the models.dev catalog, only the efforts the model takes, and the key name of the provider with Add key. A save refuses an effort the listed model does not take. `GET /admin/model-catalog` serves the catalog, which the API refreshes daily (DI-21.27).
- An opencode session reads its model from the same catalog. A model id typed by hand that the catalog lacks still runs (DI-21.28).

### Changed

- The `agents` block of `.factoree/config.yaml` is ignored. The setup report says so, and a setup removes it.

## [0.6.15] - 2026-11-09

### Changed

- The reviewer's check sprite builds while deterministic verification runs, so the reviewer starts as soon as verify passes. A failed verify destroys that sprite in the background, and the repair starts at once (DI-21.23).

## [0.6.14] - 2026-11-09

### Changed

- A Run that ends `CONFIGURATION_INVALID` keeps the cause after the fixed sentence: "Cause: " and the error text of the step that failed, such as the bootstrap exit code and its output tail, clipped to 2,000 characters and redacted (DI-21.22).
- A Run that ends `INTERNAL_ERROR` stores "Factoree stopped the Run because of an internal error. Cause: …" and posts it to the Linear agent session with the follow-up reply prompt (DI-21.22).
- The compose Temporal keeps closed workflows for 7 days instead of 1. A one-shot `temporal-retention` service updates an existing namespace (DI-21.22).

## [0.6.13] - 2026-11-06

### Added

- A setup computes its setup input key from the default-branch head SHA and the rendered setup prompt before any sandbox starts. When the newest ended setup of the repository is `unchanged` with the same key, the setup skips its session and copies that report: "no change (skipped)" (DI-21.21).
- The setup session sandbox starts from the repository's warm snapshot of the current Kiln template. The bootstrap allow list then keeps the existing hosts beside the hosts the session reached. The proof sandbox stays cold (DI-21.21).
- The setup history page of each repository ("History" on the product page) lists every setup with its total, agent and proof time, cost, tokens, turns, model and tool time, warm, cold or skipped, the pull request, the Temporal run and the report with its app-change issues (DI-21.21).

### Changed

- The setup prompt is `setup@7`. It holds the repository instruction file (AGENTS.md, else CLAUDE.md, else CONTRIBUTING.md, capped at 64 KB) under the setup rules, and on a configured repository it limits the agent's own runs to the parts it changes and their dependents (DI-21.21).

## [0.6.12] - 2026-11-06

### Fixed

- A setup whose agent keeps the config on the default branch no longer fails on an empty patch. Factoree proves that config as it is and ends the setup as `unchanged` ("no change" on the product page), with no pull request (DI-21.20).
- An `unchanged` setup creates and delegates its app-change issues when it ends, because no merge ever comes for it (DI-21.20).
- A merged setup creates no app-change issues when a newer setup of the repository holds a report, so an old report creates no duplicate issues (DI-21.20).
- The setup report no longer lists the sandbox's own hostname, or another name with no dot, as a denied host (DI-21.20).

### Changed

- The setup prompt is `setup@6`. It lists the app changes with an open issue, so the agent repeats a still-needed change word for word and Factoree dedupes it (DI-21.20).

## [0.6.11] - 2026-11-06

### Added

- A merged setup creates a Linear issue for each app change in its report and delegates it to Factoree. The product setting "App change issues" creates one issue per change (the default) or one for all. Factoree reads the merge from each push to the default branch and the GitHub pull request state, so the GitHub App needs no new event (DI-21.19).
- Factoree stores each app-change issue and creates no second issue for a change an open issue requests. The setup report names such a change as "already requested" (DI-21.19).
- When every app-change issue of a setup has ended and one of their pull requests merged, Factoree runs the setup of the repository again, so it can add the fakes the changes made possible (DI-21.19).
- The repository list on the product page has a filter and scrolls in a bounded area. Each setup button shows a spinner while its request runs.

### Changed

- A registered repository reads "active" on the product page, whatever its latest setup says. It read "pull request open" after its setup pull request merged.
- The setup prompt (`setup@5`) tells the agent that each app-change line becomes a Linear issue, and to never name a denied host there.

### Fixed

- The product save bar ends the page. It stopped between the product form and the repository list.

## [0.6.10] - 2026-11-06

### Changed

- A setup run gives its agent the parts the previous setup of the repository could not prove, with their reasons. The setup prompt (`setup@4`) asks it to try them again and to add every part the config lacks: a test command, the accounts, the fakes. A setup pull request holds only the proven parts, so the next run had kept that config as it was (DI-21.18).

## [0.6.9] - 2026-11-06

### Fixed

- A repository with no `agents` block runs every role on opencode, the runner the sandbox image ships. The validator and the reviewer defaulted to `claude`, so the refiner of FAC-74 failed with `sh: 1: claude: not found` (DI-21.17).
- A runner session that exits 127 ends the Run as a configuration error that names the runner and the shell output, not as "The refiner wrote no proposal" (DI-21.17).

## [0.6.8] - 2026-11-05

### Fixed

- An account sign-in gives each step what is left of its 60-second budget, not an equal share. A setup proof failed the first `fill` on a cold app after 12 s, on a correct selector (DI-21.16).

## [0.6.7] - 2026-11-05

### Fixed

- Every sandbox command reads `.factoree/mise.toml` through `MISE_CONFIG_FILE`, so the toolchains a setup names are on the path in the bootstrap, the verify commands, the seed, the preview and the agent sessions. A setup proof failed with `dotnet: not found` because mise reads no `.factoree/mise.toml` by itself.
- The setup agent prompt (`setup@3`) says that the proof sandbox holds only the repository and `.factoree/`, so nothing the session installs globally carries over.

## [0.6.6] - 2026-11-05

### Changed

- A setup run records the turns of its agent session, the longest turn, and the time spent on the model and in tools.
- The setup agent prompt (`setup@2`) says that the preview must listen on every interface, that agent-browser checks each account's sign-in against the running preview, and that the session stops after 60 minutes.
- A release reuses the sandbox image of the last release when nothing under `sandbox/` changed, so its Kiln template and warm snapshots stay valid. The first release with this change still builds one.

### Fixed

- A preview that never answers says when it listens on loopback only, or when nothing listens on its port.
- The setup report shows the first error of a failed command, not only the last lines, so a failed test run names its reason.

## [0.6.5] - 2026-11-05

### Fixed

- Rootless Docker starts in a Kiln sandbox. The sandbox image now holds `/etc/hosts`, which rootlesskit needs and a Kiln guest lacks. On Kiln v0.16.2 it starts in about 23 s and runs a Postgres stack on `localhost`.
- A setup sandbox can pull images from Docker Hub, which now also serves image data from `production.cloudfront.docker.com`.

## [0.6.4] - 2026-11-05

### Changed

- The sandbox image needs Kiln v0.16.2 or later for Docker. An older Kiln left `/dev/net/tun` closed to the sandbox user, so rootless Docker could not set up its network. This release has a new sandbox image digest, so Kiln builds a new template and each repository starts cold once.
- The sandbox environment turns off .NET CLI telemetry and its first-run banner.

## [0.6.3] - 2026-11-05

### Changed

- The sandbox image needs Kiln v0.16.1 or later for Docker. An older Kiln built templates without the setuid bit of `newuidmap`, so rootless Docker did not start. This release has a new sandbox image digest, so Kiln builds a new template and each repository starts cold once.
- The ecosystem host list no longer holds the certificate revocation hosts. NuGet checks revocation offline in the sandbox, so no tool used them.

## [0.6.2] - 2026-11-05

### Fixed

- `dotnet restore` in a sandbox no longer waits minutes on certificate revocation checks. The sandbox environment sets `NUGET_CERT_REVOCATION_MODE=offline`, because the Kiln egress filter drops the plain HTTP requests these checks make. NuGet still verifies each package signature.

## [0.6.1] - 2026-11-05

### Fixed

- A setup sandbox reaches the download hosts of common stacks: `dot.net` and the NuGet signature revocation hosts for .NET, Bun, Deno, JSR, Prisma, Playwright and Cypress downloads for TypeScript, Poetry and conda for Python, the Gradle wrapper, Google Maven and the JDK vendors for Java and Kotlin, rustup, Composer, GCR, ECR Public and raw GitHub files. The first anthology setup was denied `dot.net`.

## [0.6.0] - 2026-11-05

### Added

- A setup run writes the Factoree config of a repository. On the product page, under Repositories, an operator starts a setup for one or more repositories the GitHub App can read. A setup agent writes `.factoree/` in a sandbox, Factoree proves each part in a fresh sandbox (the bootstrap, each verify command, the services and the seed, the preview, each account) and opens a pull request with the parts that passed and a report of the parts that did not. A host the sandbox was denied can go on the product allow list with one click.
- A repository can run its compose stack. The sandbox image runs rootless Docker and Docker Compose as the sandbox user, and `services` in the config names the compose file, the profiles and a seed command. The stack starts before the bootstrap and is part of the warm snapshot. `docker: true` gives Testcontainers a socket without a stack.
- `bootstrap.keyFiles` names the lockfiles and toolchain files that key the warm snapshot, so a change to one starts a build-ahead. The sandbox image holds mise for toolchains the image lacks. `bootstrap.allowedDomains` gives ecosystem hosts to the bootstrap phase only.
- `accounts` in the config names users the seed creates. A browser plan entry with `"as"` starts signed in, and Factoree signs each account in once per check sprite. A fake external API, a compose service labelled `factoree.fake`, is named to the validator and in the proof pack.

### Changed

- A delegation in a product with no repository answers with the link to the product page instead of an empty target question.
- A build-ahead that fails on the config marks the repository "Needs setup" on the product page.
- The sandbox image needs Kiln v0.15.0 or later for overlay2 storage. On an older Kiln, Docker stores its data with vfs, which is slower.

## [0.5.0] - 2026-11-05

### Added

- A browser step in a Validation Plan can hold the requests that match a URL glob until a release step, or fail them with an HTTP error status or a network error. A held request releases itself after 30 seconds. A screenshot of a loading state is then the same on every run, and a plan can prove an error state with the real page code. No step invents a response body. The proof pack marks an assertion whose plan injected a failed request.

### Changed

- A follow-up run whose reply replaced the browser checks of the failed run says so in its proof pack, under Needs your attention, because it captures no visual evidence.

## [0.4.1] - 2026-11-04

### Fixed

- A follow-up run reused the row of the failed run it follows up and ended on an internal error. The run now records the workflow id it runs under, so a follow-up run gets a row of its own.

## [0.4.0] - 2026-11-04

### Added

- A failed run posts what blocked it, from its recorded assertion results and review findings, and example replies. A reply in the same Linear agent session starts a follow-up run that refines the issue again with the reply as the highest decision, so the reply can drop or change a criterion. The follow-up run sees the facts and the last patch of the failed run, and starts from the base with a new repair budget.
- A browser assertion that fails runs once more in the same check sprite. When the second run passes, the assertion is unstable: it spends no repair, the pull request is a draft, and the proof pack lists it first under Needs your attention.

### Changed

- A reply after a run that succeeded, was cancelled or failed on its configuration gets one line in Linear and starts no run.

## [0.3.0] - 2026-11-04

### Added

- A Runs page lists every run of a workspace, newest first, with its work item, status, duration, cost, repairs and pull request, filtered by product and status. A run page shows why the run ended, its stage timeline, every agent session with tokens, cost, model time and tool time, the assertion results of each attempt, the review findings and the skills.
- An admin opens the Temporal UI at `/temporal` with the Factoree sign-in. It is read-only, and everyone else gets 404. The compose stack and the Helm chart run it with no published port.

### Changed

- The control plane UI uses the width of a desktop screen: content up to 1440 px, centered, with the product page and the install settings in two columns.

## [0.2.2] - 2026-11-04

### Added

- When a failed check starts a repair, Factoree posts one line to Linear with the repair number, the reason and the number of findings the implementer receives. A long repair no longer looks dead, and Linear no longer marks the agent session stale.

## [0.2.1] - 2026-11-04

### Fixed

- The usage of an opencode session with a large transcript was lost. opencode cuts off a large `opencode export` written to a pipe (anomalyco/opencode#57266), so the export arrived as invalid JSON. Factoree now writes the export to a file in the sandbox and reads the file. The session keeps its cost, tokens, model time, tool time and the skills it loaded.

## [0.2.0] - 2026-11-04

Faster runs, skills from a skill registry, and E2B as a sandbox provider.

### Added

- A skill registry per product. Skael is the first kind. The product names the registry URL and an optional set, and the service key is the product secret `SKILL_REGISTRY_KEY`. An empty set gives every released skill. Saving resolves the registry once and refuses a setting that does not resolve.
- For each run, the worker resolves the registry, checks the SHA-256 of every skill archive and unpacks the skills outside the repository checkout of the work sprite. The sandbox gets no key and no route to the registry. Repository skills rank first, then registry skills, then organization skills.
- The run records the set, the resolution id and each skill it received, with its version and digest, in `run_skill`.
- Factoree reports the skills each implementer session loaded and the run outcome to the registry.
- The implementer may write one skill proposal. It never reaches the pull request. Factoree sends it to the registry, or as a pull request to the organization skills repository, for a person to review. The proof pack lists the loaded skills and the proposal.
- The sandbox provider `e2b`, with one template per image digest and size, egress at the E2B proxy, and a warm snapshot per repository.
- The `run_stage` table records the start and the end of each stage of a run. Each agent session records its model time and its tool time.
- The optional repository command `warm.command` runs only when Factoree takes a warm snapshot, so the snapshot holds warm build caches.
- A build-ahead builds a new warm snapshot when the bootstrap key of a repository changes, when the product allow list changes, or when the sandbox image or size changes, before a run needs it.

### Changed

- The reviewer runs in its own check sprite at the same time as user validation, after verification passes. It no longer receives the user validation evidence. One repair gets the findings of both.
- The bootstrap key (the bootstrap command, the warm command and the allow list) replaces the configuration SHA as the key of a warm snapshot. The first run of each repository after the upgrade starts cold once.
- The implementer prompt is `implementer/8`. When a run lists only the first 50 skills, the prompt names the directories of the others.

## [0.1.0] - 2026-11-01

The first release. Another person can install Factoree from released artefacts and run it with no checkout.

### Added

- A Linear issue delegated to Factoree starts one run: one Temporal workflow that freezes a context contract and a validation contract, runs the implementer in a work sprite, and verifies, validates and reviews each attempt in a fresh check sprite.
- A refiner agent proposes criteria and checks as data before the contracts freeze. Factoree takes a determined proposal without a question and asks the human the rest in Linear.
- Factoree publishes the verified patch as a GitHub pull request only when its SHA-256 hash reproduces, and posts a proof pack with visual evidence to Linear.
- Autonomy levels L0 to L3 per product, with risk caps per Linear label.
- Multi-repository tenancy: a tenant is a Linear workspace, a product maps to a Linear team, and a repository registers itself with `.factoree/config.yaml` through the GitHub App.
- Sandbox providers: Kiln, with a warm snapshot per repository, Fly Sprites and a local process sandbox for development.
- Each agent session records its tokens, cost, turns and longest turn. The admin API returns the sessions, and the proof pack shows the totals.
- An agent session that writes no output for the product's silence limit is hung. Factoree stops it and tries once more. A second hang in the same step fails the run with `AGENT_HUNG`.
- When the plan rules reject the user validator's Validation Plan, Factoree resumes the validator session once with every rejection reason and asks for the full corrected plan. Without a resumable session it starts one fresh validator session with the same message. A second rejection ends the run `VALIDATION_BLOCKED` with both reasons. The correction does not use the repair budget, and the proof pack names the attempt whose first plan was rejected.
- Setup in the web UI at `/setup`, guarded by a one-time setup token that the API logs at start: the GitHub App from a manifest, the Linear OAuth app and its install, the GitHub App install, the sandbox provider, and the first product.
- Setup takes over a Linear installation that the database already holds, because Linear does not install the app again in a workspace that has it. The stored token must still work, and the GitHub installations of another App are unbound.
- Sign-in with Linear through better-auth. Only members of a set-up Linear workspace get in, and a Linear workspace admin is a Factoree admin.
- API keys per person replace `ADMIN_API_TOKEN`. A script sends a key as `Authorization: Bearer`. Every admin API call records the user or the key.
- A web UI in `ui/`, served by the API from the same origin: install settings, workspaces, products with model, effort per role, silence limit, policy, secrets, retention and concurrency, and API keys.
- The OpenAPI document of the API in `api/openapi.json` and at `GET /api/openapi.json`. `checks/gen-check.sh` fails when the document or the UI client is stale.
- `maxConcurrentRuns` per product, 2 by default. A run over the limit waits in the new run state `QUEUED` before `PREPARING`, and the queue starts in delegation order. The Linear issue shows `Queued: N runs ahead.` and a new line only when the position changes. A stopped run leaves the queue. A wait in the queue does not spend the run budget.
- The install setting `sandboxMaxLive`. Before a sandbox create, Factoree counts its live sandboxes of the provider, retained ones included. At the limit it deletes its oldest retained sandbox. With none retained, the run waits for a slot until its budget ends, and does not fail. Concurrent creates on any worker never pass the limit.
- One image, `ghcr.io/alternayte/factoree`, with the commands `api`, `worker`, `migrate` and `--version`. The image pins the digest of the matching sandbox image, `ghcr.io/alternayte/factoree-sandbox`.
- `GET /version` returns the version, the commit and the build date. The worker logs them at start.
- `deploy/compose/compose.yml` starts PostgreSQL, Temporal on the same PostgreSQL, a one-time migration, the API and the worker from the released images.
- The Helm chart `oci://ghcr.io/alternayte/charts/factoree` deploys the API, the worker and a migration Job against an external PostgreSQL and an external Temporal.
- `examples/` holds a `.factoree/config.yaml` for a Node web app and for a Go service.
- The product page shows what an empty model or effort means, warns when the product sets no model, and lists the model and effort of the last agent sessions from `GET /admin/products/:id/agent-sessions`. The proof pack warns when opencode chose its own model and the product holds no runner credential.
- Help popovers explain the autonomy levels L0 to L4, risk caps and allowed domains on the product page and in setup. Each autonomy option shows its one-line description.
- A Context sources section on the product page lists, adds, tests and deletes MCP servers and Backstage catalogs, with the time of the last read. `POST /admin/products/:id/context-sources/test` calls the discover tool before a save. The context source routes are in the OpenAPI document.
- The implementer prompt names the verify commands that Factoree runs after the implementer finishes, and says that a failed check returns as repair findings. It never names the preview command, so the implementer does not run a production build in the work sprite. When the work sprite holds agent-browser, the prompt says so, and a browser check is optional.
- The user validator prompt states that the verify commands already passed, that Factoree runs the Validation Plan, and that the preview may still be building. The validator writes the plan from the source and does not start the app or run the checks again.
- The install settings hold the vCPUs and the memory of each Kiln sandbox, 4 vCPUs and 4096 MB by default. The Kiln template name holds the image digest and the size, so a size change builds a new template, and each repository starts cold once.
- `checks/migrations.sh` fails when a migration of the latest release changes or disappears. `scripts/upgrade-test.sh` migrates a database of the previous release to the working tree.

### Changed

- The environment holds infrastructure only, and every name has the `FACTOREE_` prefix. Rename these variables:

  | Before | 0.1.0 |
  |---|---|
  | `DATABASE_URL` | `FACTOREE_DATABASE_URL` |
  | `FACTOREE_SECRET_KEY` | `FACTOREE_MASTER_KEY` |
  | `TEMPORAL_ADDRESS` | `FACTOREE_TEMPORAL_ADDRESS` |
  | `TEMPORAL_NAMESPACE` | `FACTOREE_TEMPORAL_NAMESPACE` |
  | `TEMPORAL_TASK_QUEUE` | `FACTOREE_TEMPORAL_TASK_QUEUE` |
  | `TEMPORAL_API_KEY` | `FACTOREE_TEMPORAL_API_KEY` |
  | `PORT` | `FACTOREE_PORT` |
  | `LOG_LEVEL` | `FACTOREE_LOG_LEVEL` |
  | `SANDBOX_LOCAL_ROOT` | `FACTOREE_SANDBOX_LOCAL_ROOT` |
  | `EVIDENCE_STORAGE` | `FACTOREE_EVIDENCE_STORAGE` |
  | `EVIDENCE_LOCAL_ROOT` | `FACTOREE_EVIDENCE_LOCAL_ROOT` |

  `FACTOREE_PUBLIC_URL` is new and required. `FACTOREE_UNSAFE_LOCAL_SANDBOX` keeps its name.
- These settings moved from the environment to the install settings in the database. Setup stores them, and Settings, Install changes them. No environment fallback exists:
  `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_BASE_URL`, `GITHUB_API_BASE_URL`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `SANDBOX_ADAPTER`, `SPRITES_TOKEN`, `SPRITES_BASE_URL`, `KILN_URL`, `KILN_API_KEY`, `KILN_IMAGE` (now an override of the image the release pins), `KILN_REGISTRY_USERNAME`, `KILN_REGISTRY_TOKEN`, `FACTOREE_GIT_AUTHOR_NAME` and `FACTOREE_GIT_AUTHOR_EMAIL`.
- These settings moved from the environment to each product: `OPENCODE_MODEL` (the model), `OPENCODE_VARIANT_IMPLEMENTER`, `OPENCODE_VARIANT_REFINER`, `OPENCODE_VARIANT_VALIDATOR` and `OPENCODE_VARIANT_REVIEWER` (the effort per role), and `AGENT_SILENCE_MINUTES` (the silence limit). The product also holds the sandbox retention and `maxConcurrentRuns`.
- Factoree encrypts every stored credential with `FACTOREE_MASTER_KEY`. Setup takes the values again, and nothing imports the old environment values.

### Removed

- `ADMIN_API_TOKEN`. Use an API key.
- `OPENCODE_VARIANT`. Set the effort of each role on the product.
- The `SETUP_*` variables, `just bootstrap` and `tools/local/linear-auth.mjs`. Setup in the web UI does their work.

[Unreleased]: https://github.com/alternayte/factoree/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alternayte/factoree/releases/tag/v0.1.0
