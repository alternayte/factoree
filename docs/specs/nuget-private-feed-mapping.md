# NuGet private feed mapping

Amends `docs/factoree-sdd.md` §29, §30, §35 and §56, `docs/specs/host-credentials.md`, `docs/specs/private-stack-onboarding.md`, `docs/specs/repository-setup-and-services.md` and `docs/specs/setup-speed-and-history.md`. Closes GitHub issue 118.

## What it does
A .NET repository whose committed `NuGet.config` names the private feed `nuget.frontiersin.net` sets up without a change to the repository. No sandbox reaches that feed: it is private and Factoree holds no credential for it. Its packages are mirrored to GitHub Packages at `nuget.pkg.github.com/frontiersin`, which a product host credential reaches.

Before the setup agent starts, Factoree runs a NuGet pre-check in a sandbox:
1. It reads the feeds of every `NuGet.config` in the checkout.
2. It collects the packages that the projects, `Directory.Packages.props`, `packages.config` and `dotnet-tools.json` reference.
3. It drops the packages that nuget.org has, by exact id and version, and lists.
4. If no package is left and the feed is the mirror, it stops.
5. It checks the product's host credential for the mirror.
6. It looks each private package up on the mirror, through the index and a download of the exact version.
7. It writes `.factoree/nuget.config`, which replaces only the private feed.
8. It restores with that file, and looks up each transitive package the restore cannot find, for at most 5 rounds.

A missing package, or a missing credential when one is needed, fails the whole setup. The report names each package, the file that references it, its parents when it is transitive, and the fix: mirror these packages to https://github.com/orgs/frontiersin/packages, or fix the credential. A failed pre-check starts no agent session and creates no app-change issue.

A pre-check that passes gives the setup agent the file, and the prompt tells the agent to restore with it.

## Decisions
- Factoree maps exactly one private feed, one constant pair in `src/domain/setup/nuget-feeds.ts`: `nuget.frontiersin.net` to `nuget.pkg.github.com/frontiersin`. Any other private feed fails the setup with "unsupported private feed `<host>`", even when no package uses it. Widening the pair is a code change on purpose (DI-21.223).
- A source is public when the ecosystem host list or the product allow list covers its host. A source is covered when a product host credential names its host. The pre-check runs only when a config names the mapped feed, the mirror host, or an unsupported feed. A repository whose sources are all public or covered sets up as before (DI-21.223).
- The pre-check also runs when a config does not read over GitHub, or the tree is too large to list, because an unread config may name the mapped feed. The pre-check reads the checkout itself. A checkout scan that does not finish, a file it cannot read, or a config, project or solution over its size limit fails the pre-check (DI-21.222).
- A repository that already restores from `nuget.pkg.github.com/<owner>` gets only the credential check, with the owner from its URL. Factoree writes no file for it (DI-21.231).
- The package read takes exact versions, `[x]` included. A floating version, a range and an unresolved MSBuild property are unchecked: the report names them and the restore decides. Conditions are not evaluated, so each conditional version is one more check, and a conditional `Update` or `Remove` keeps what it replaces. `Update` and `Remove` apply in import order. Each project reads the nearest `Directory.Build.props`, `Directory.Packages.props` and `Directory.Build.targets`, and a parent one only when that file imports it, by `GetPathOfFileAbove` or by a path relative to the importing file. A property expands where it is assigned, so a property defined later stays unresolved. An expression with more than 8 values is unchecked. Central package management, `VersionOverride` and `GlobalPackageReference` apply. A `GlobalPackageReference` counts only from a `Directory.Packages.props` a project imports (DI-21.224).
- A package is public only when the nuget.org flat container names the exact normalised version and its registration leaf is not unlisted. A package that only shares an id with a public one stays private. A nuget.org fault fails the pre-check, because a guess either way sends people to the wrong fix (DI-21.225).
- An id the repository's own `packageSourceMapping` sends only to the mapped feed is private, whatever nuget.org has. When one version of an id is private, every version of that id is looked up on the mirror, because the mapping takes no version (DI-21.227).
- The credential check runs only when a package needs the mirror. It needs a `header` credential for `nuget.pkg.github.com` with the header name `Authorization`. When the credential sets a path prefix, the prefix must be `/`, `/frontiersin` or `/frontiersin/` in that case, so it reaches the index and every download whatever case the provider matches in. The missing-credential text contains "add a host credential for nuget.pkg.github.com" (`docs/specs/host-credentials.md`).
- A mirror lookup reads `/<owner>/download/<id>/index.json`, then requests the exact `.nupkg` without following the redirect. The redirect host must be on the sandbox egress, which includes each redirect host of the credential. Factoree then downloads one byte through the redirect, which must end in a 2xx. Only the host of the redirect URL leaves the lookup, because its query is signed (DI-21.226).
- Each status has a fixed text:
  - A 404 is "not on the mirror, or the token cannot read it", with both fixes, because GitHub Packages answers 404 for a package the token cannot read.
  - A 401 or 403 names the credential.
  - A block or a timeout is "feed unreachable".
  - A version the index does not list is its own status.
- Every mirror request runs inside the sandbox, where the sandbox provider adds the credential. No secret reaches the worker, a prompt, the report or a file (`docs/specs/host-credentials.md`).
- `.factoree/nuget.config` copies the sources of the repository's configs in order and leaves out each disabled source (DI-21.227):
  - It replaces the mapped feed with the mirror, under the original key, when a package needs it. Otherwise it drops the mapped feed, because a source no sandbox reaches fails every restore with NU1301.
  - It keeps `<clear />` only when the shallowest config had it.
  - It adds nuget.org when no kept source is nuget.org, because `--configfile` reads no other file.
  - It rebases a relative local folder from the config that names it.
  - It writes `packageSourceMapping`: each mirrored id to the mirror, and `*` to every other source. When the repository maps its sources itself, its patterns stay, and those of the mapped feed move to the mirror, except `*`, which moves to nuget.org because the mapped feed proxied nuget.org. nuget.org gets `*` only then, so it never widens the repository's own mapping.
- The restore loop runs `dotnet restore <target> --configfile .factoree/nuget.config` on each solution and each project no solution names, at most 20 targets. It restores into an emptied global packages folder and HTTP cache, because a warm sandbox holds the packages its bootstrap restored, and restore would take a transitive private package from there without reading the mirror. The report notes the targets past the limit, also when the restore passed (DI-21.228):
  - A sandbox image with no .NET SDK gets the SDK that `global.json` names, or LTS, from `dotnet-install.sh`. When none installs, the pre-check checks the direct references only.
  - NU1101 and NU1102 name the missing packages. Factoree looks each one up on the mirror and reads its parent chain from `obj/project.assets.json`.
  - NU1101 names no version, so Factoree takes the lowest version the parents ask for in `obj/project.assets.json`, the inclusive lower bound of a range. A range with no inclusive lower bound names no version. Only `[x]` and NU1102 `= x` are exact. Any other request takes the lowest version the mirror lists at or above it, a release unless the request is a prerelease, as restore does. It verifies the exact `.nupkg` download and its redirect host on the mirror, as for a direct reference. Only when the assets file names no parent version does it check the mirror index alone, and the report names the version `(any)` (DI-21.232).
  - A found package joins the mapping and the next round runs. A missing one fails the setup.
  - The same missing package twice, or 5 rounds, fails the setup.
  - A restore that cannot load the mirror's service index (NU1301) fails the setup, because the agent cannot change the file.
  - A restore that fails for another reason passes the pre-check with a note, because the setup agent sees the same failure and repairs it in `.factoree/`.
- A failed pre-check records a run event `command_failed` with the step `setup_precheck:nuget`. It stores the setup report with the pre-check evidence and the parts of the setup before it, so the next setup still names what is unproven (DI-21.18). The report renders only the pre-check evidence (DI-21.229).
- The pre-check runs before the setup input key and decides part of it: the outcome, the credential state, the mirrored ids and each package status. A setup whose previous setup failed in the pre-check is never skipped, because only an unchanged setup is a skip source. A passed pre-check with the same inputs skips as before (DI-21.222).
- In the workflow, `prepareSetup` returns a new result kind, `precheck`, and the workflow then runs the activity `precheckNugetFeeds` in a held slot. A history recorded before this change holds no `precheck` result and replays down the old path, so no `patched()` marker is needed (DI-21.222).
- How the file is applied (DI-21.230):
  - The setup session gets `.factoree/nuget.config` before it starts. Factoree writes it again after the session and before the patch capture, so an agent change to it never lands.
  - The setup prompt (`setup@18`) tells the agent to restore in `bootstrap.command` with `dotnet restore --configfile .factoree/nuget.config`, and with `dotnet tool restore --configfile .factoree/nuget.config` when the repository has a tool manifest. It also tells the agent to pass `--no-restore` to every later `dotnet build`, `test`, `run` and `publish`, in `warm.command`, the verify commands and the preview.
  - The file lands in the setup pull request, so every work sprite and check sprite has it at the base SHA. The bootstrap restores with it, and the verify commands do no implicit restore against the committed `NuGet.config`.
  - The implementer prompt (`implementer/14`) carries one fixed line with the same rule, `dotnet tool restore` and `dotnet publish` included.
  - Factoree rejected the `RestoreConfigFile` MSBuild property in the sandbox environment: a missing file fails every restore, and it would need a per-sandbox environment.
- The derived host list never names `nuget.frontiersin.net` as uncovered, because the setup maps it (`docs/specs/private-stack-onboarding.md`).

## Out
- npm, Maven and RubyGems private feeds.
- A second mapped feed or an owner other than `frontiersin`.
- Mirroring a package. Factoree names what is missing, and a person mirrors it.
- Evaluating MSBuild conditions or imports other than `Directory.Build.props`, `Directory.Packages.props` and `Directory.Build.targets`.

## How I know it works
- Unit:
  - `tests/unit/nuget-packages.test.ts` covers the XML reader, versions, the project, central package management, `packages.config` and tool manifest reads.
  - `tests/unit/nuget-feeds.test.ts` covers config parsing, feed classes, the credential check, status texts, the generated file, restore output and the parent chain.
  - `tests/unit/nuget-precheck.test.ts` covers each Acceptance outcome against a fake sandbox.
- Activity: `tests/unit/setup-activities.test.ts` covers the following:
  - The pre-check comes before the key.
  - A failed pre-check starts no session and records the event and the report.
  - The credential text names the host.
  - An unsupported feed fails.
  - An unused feed passes with no credential.
  - A failed pre-check is never skipped, and a passed one skips.
  - The file reaches the session and is written again after it.
- Report and prompts: `tests/unit/setup-report.test.ts`, `tests/unit/setup-prompt.test.ts` and `tests/unit/derived-hosts.test.ts`.
- Workflow: `tests/workflow/repository-setup.workflow.test.ts` covers the three paths: no pre-check, a failed pre-check, and a passed pre-check.
- Integration: `tests/integration/setup-nuget-precheck.test.ts` stores the failed report and the run event in PostgreSQL, renders the report, and checks that the next setup is not skipped.
- Not run live: a setup of a Frontiers .NET repository on Kiln with the real mirror and a real credential.
