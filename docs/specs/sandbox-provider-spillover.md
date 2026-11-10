# Sandbox provider spillover

Amends DI-14.50 (one provider in the install settings), DI-15.14 and DI-15.15 (the sandbox slot), DI-15.28 (the sandbox size), DI-16.05 (build-ahead) and DI-21.56 (the slot wait).

## What it does
The operator lists several sandbox providers in the install settings, for example two Kiln hosts and E2B cloud. Each provider has its own live sandbox limit, size and priority. A run picks one provider when it starts and keeps it for its work sprite and every check sprite. Factoree takes the best-priority provider with room, spreads runs over providers of equal priority, and uses a lower priority only when the better ones are full. A product can limit its runs to some providers, and build-ahead keeps a warm snapshot of each repository on every provider that its product allows.

## Decisions
- A run is pinned to one provider — a check result must not depend on which provider ran it.
- The install settings hold an ordered list of providers, each with a stable id, a name, a type, a URL, a key, `maxLive`, `vcpus`, `memoryMb`, a priority and an enabled flag — the list can hold two providers of one type, which is how Kiln grows past one host.
- The sandbox image and its pull credential stay install-wide — one image (DI-15.11) serves every provider, and each provider builds its own template from it at its own size.
- `SandboxLease`, `WarmSnapshot`, `RetiredWarmSnapshot` and the Run key by provider id, not by adapter name, and a sandbox ref names its provider id — two providers of one type must not share leases or snapshots.
- The migration makes the current provider entry 1 at priority 1 and moves every existing row to its id — an install keeps its runs, leases and warm snapshots.
- Selection takes the best priority with room, and among equal priorities the provider with the most free slots — fixed-price hosts fill first and share load, and a pay-per-use cloud takes only the spillover.
- A run holds 3 slots on its provider from start to its terminal write, and each create uses a held slot — a run that starts never waits mid-run for a check sprite. A retained sprite counts as free, because Factoree evicts it at the limit.
- With no provider that has 3 free slots, the run waits as today and selects again every 30 s, and the wait goes into `waitedMs` — the deadline moves with the wait (DI-21.56).
- Selection skips a provider that lacks a capability the repository needs, such as `supportsDocker` — a run must not land where its config cannot start.
- A product has a list of allowed provider ids, and an empty list allows all — the product owns its policy, and some code and secrets must stay on the operator's hardware.
- Build-ahead builds the warm snapshot of a repository on every enabled provider that its product allows — a spillover run starts warm.
- A failed build-ahead on a provider is stored per repository and provider with its reason, and selection skips that provider for that repository until a later build-ahead there succeeds — a run must not land where its repository is known to fail.
- A provider error on the work sprite create marks the provider down for 5 minutes, frees the held slots and selects again. After the work sprite exists, a provider error fails the run as today — before the first sandbox, a move costs nothing, and after it the pin holds.
- A setup run uses the same selection rule. Build-ahead after the merge proves the config on the other providers — one setup per repository is enough.
- A disabled provider takes no new run or build-ahead, and runs already on it finish. The API refuses to delete a provider that has live leases — no sandbox loses its provider.
- Retention and eviction work per provider — a full provider evicts only its own retained sprites.
- The run page and the proof pack name the provider of the run — the operator sees where a run ran.

## Out
- Moving a run to another provider after its work sprite exists.
- Selection by price, region or load measured on the host.
- An image or a pull credential per provider.
- A cooldown setting.
- A change to `maxConcurrentRuns`.

## How I know it works
- An install with two enabled providers shows both on the settings page, with the limit, size, priority and state of each.
- With Kiln at priority 1 (`maxLive` 6) and E2B at priority 2, a third run that starts while two runs hold Kiln shows E2B on its run page and in its proof pack.
- Two Kiln providers at the same priority, with 2 runs started, show one run on each.
- A product that allows Kiln only waits in QUEUED while Kiln is full, and its run never shows E2B.
- `SELECT provider_id, count(*) FROM sandbox_lease GROUP BY 1` never shows more rows for a provider than its `maxLive`, and a started run holds 3.
- After a config change, `warm_snapshot` holds one row for each allowed provider of the repository.
- A Kiln URL that does not answer makes the next run start on E2B within one selection, and the settings page shows Kiln as down.
- A build-ahead that fails on E2B shows its reason on the repository page, and the next run of that repository does not start on E2B.
- An existing install after the migration runs its next run on entry 1 with a warm start.
