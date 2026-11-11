# Change sets

Amends `docs/factoree-sdd.md` §4, §8, §44, §45, §47, §48 and §71, `docs/specs/multi-repo-tenancy.md` §5, §10 and §12 to §18, `docs/specs/own-proposals-and-parallel-runs.md`, `docs/specs/repository-setup-and-services.md` and `docs/specs/run-recovery.md`. Supersedes H-A2 and issues #15 and #26 to #29.

## What it does
One run can change several repositories of one product. The worker rules pick the starting set. The refiner can add a repository when it cites the code that needs the change. The implementer works on every target in one work sprite. Each check sprite verifies every target, runs a consumer against its patched provider when the pair is wired, and checks each consumer at its base against the provider patches. Factoree opens one linked pull request per target, posts one proof pack, and sets a merge-order status on each consumer pull request.

## Decisions
- One run changes every target, with one work sprite, one validation contract, one review and one proof pack — the operator delegates once and reads one session.
- The starting set is every repository that the issue names, or that the Linear project maps to — the worker rules of the own-proposals spec, extended from one to many.
- The refiner reads the other repositories of the product through `clone_sibling`, read-only and with evidence. It adds a target only with a cited file and line, as a determined proposal. Factoree asks a human only when no rule and no citation decide — the operator usually names nothing, and P-05 forbids a guess.
- When the refiner adds a target, the work sprite restores again from a set snapshot if one exists, else Factoree clones and bootstraps the target cold — the refiner output is data, so nothing is lost.
- The set freezes with the validation contract. An implementer that needs another repository gets a finding and no new target — it is a new criterion.
- Each target checks out at `<workspace>/targets/<owner>/<repo>`. A single-target run keeps `<workspace>/primary` — single-target warm snapshots stay valid.
- A warm snapshot can hold a set. Its key is the sorted list of repository and bootstrap key. A run with no snapshot for its set restores the first target's snapshot, adds the others cold, and starts a build-ahead for the set. Build-ahead keeps a set snapshot current after that — recurring sets start warm, and nothing is built for unused sets.
- A fake in `.factoree/config.yaml` can name the product repository that serves it. The setup agent writes it when the product holds that repository — the pairing costs the operator nothing.
- A wired pair runs together in the check sprite: each stack as its own compose project, the provider preview started, and the consumer pointed at it in place of the fake. Every other target runs its stack alone, one after the other — memory stays at today's peak where the repositories never call each other.
- When a set snapshot build cannot start a wired pair within the provider size, the run tests the targets alone, and "Needs your attention" states why — a slow or tight host must not fail a run.
- After the full set passes, the same check sprite resets each consumer to its base with the provider patches kept, and runs its verify commands and its paired assertions. A failure goes to repair with a finding that the provider breaks the consumer — production runs this state between the two merges.
- Each target uses its own verify commands, accounts and preview, in its own folder. A user assertion names its target, or names the set for a wired pair — config stays owned by each repository.
- One repair budget covers the set. Its size is the smallest `repair.maxAttempts` among the targets — the stricter limit governs.
- The allowed hosts are the union of the targets' hosts, capped by the product ceiling — the product owns the ceiling.
- The highest risk label in the set sets the autonomy level of the set — SDD risk rules, applied once.
- The refiner records each provider-to-consumer edge with its citation. Targets with no edge have no order. A cycle publishes with no merge-order status, and "Needs your attention" states that no safe order exists — the order is evidence, not a guess.
- Publication is all or nothing. A target that fails after the repair budget fails the run, no pull request opens, and the proof pack shows each target's result — no half change reaches GitHub.
- A moved base never stops a target. Each target publishes on its verified base, states the move, and runs the three-way apply check. `BLOCKED_STALE_SET` is removed — the own-proposals rule, per target.
- Each pull request body links every sibling pull request and states the merge order. The agent session lists every pull request URL — the human sees the set from any one of them.
- Factoree sets the commit status `factoree/change-set` on each consumer head: `pending` while a provider pull request is open, `success` when every provider has merged, and `failure` when a provider closes unmerged or gets a new head after verification. Factoree sets it again on each new consumer head — the reason shows on the pull request at L2 and L3.
- The GitHub App manifest adds `statuses: write` and the `pull_request` actions `synchronize` and `closed`. `docs/quickstart.md` tells an existing install to accept the update and to add a ruleset that requires the status — Factoree must not hold Administration write.
- `RunTarget` holds the base SHA, the config SHA, the patch hash, the commit, the pull request, the merge order and the last patch. `Run.baseSha`, `patchSha256`, `commitSha`, `pullRequestUrl`, `configSha` and `lastPatchBase64` go — one record per target, as SDD §46 needs per patch.
- A follow-up run starts from the set of the run it follows, and reads each target's last patch — the human reply refines, it does not re-route.
- The run page and the runs list show each target with its base, its pull request and its status — the run row no longer holds them.
- Every reader of the run pull request reads the run targets. The completion invariant needs one pull request per target before READY_FOR_HUMAN. The no-follow-up line names every pull request. `linkPullRequest` runs once per target. `pullRequestsOutcome` takes the state of each target pull request. The runs API returns a list of targets per run, and `just gen` makes the UI types again — `Run.pullRequestUrl` goes, so no reader may keep one URL.
- A change set takes one run slot and holds 3 sandbox slots. The sandbox size does not change — the check sprites run in sequence.
- A change set whose product selects the `cursor-cloud` implementer fails at preparation with `CONFIGURATION_INVALID`, and the message names the cause — that runner is specced for one repository.

## Out
- Automatic merge, and merging the set together.
- A target outside the product.
- Adding a target after the validation contract freezes.
- Publishing the passing targets of a failed run.
- A sandbox size per set, per product or per repository.
- Sub-issues per repository, and linked runs.
- A ruleset that Factoree creates.

## How I know it works
- A FAC issue that names c-dash and anthology reaches READY_FOR_HUMAN with one pull request in each repository. Each body links the other, and the proof pack lists both targets with their base SHAs.
- A FAC issue that names only the provider gets a second target from the refiner, and the proof pack shows the decision with its cited file and line.
- The second run of the same set restores a set snapshot. `warm_snapshot` holds one row for the set on each allowed provider.
- A provider patch that renames an endpoint the consumer calls fails the in-between check and starts a repair.
- A wired consumer assertion calls the patched provider, and the proof pack lists no fake for that API.
- The Linear issue of a change set shows one attachment per pull request, and moves to done only when every pull request has merged.
- A run whose consumer target fails after the repair budget opens no pull request in either repository.
- The consumer pull request shows `factoree/change-set` pending until the provider merges, then success. A provider closed unmerged turns it to failure.
- `just verify` passes.
