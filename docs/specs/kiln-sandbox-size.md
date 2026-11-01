# Kiln sandbox size

Amends DI-15.14 (the sandbox section of the install settings) and the Kiln template resources in `src/adapters/sandbox/kiln/kiln-sandbox.ts`.

## What it does
The operator sets the vCPU count and the memory of every Kiln sandbox once, in the sandbox section of the install settings. The /setup sandbox step and the settings page show the two fields next to the live sandbox limit. Each work sprite and each check sprite of the install gets that size. A size change builds a new Kiln template and takes one cold start for each repository. A warm snapshot of the old size is not used again.

## Decisions
- The size is one install setting, not a field of `.factoree/config.yaml` — the operator knows the Kiln host, and one size keeps one template and one warm snapshot for each repository.
- The install settings hold `sandboxVcpus` and `sandboxMemoryMb`, both nullable — null means the default.
- The default is 4 vCPUs and 4096 MB — on the Start-2-L, `npm ci`, a cold `next build` and the type-check of c-dash took 387 s at 4 vCPUs and 475 s at 2 vCPUs in the same probe, and the memory does not change.
- The disk stays at 16384 MB and is not a setting — no repository needs more.
- The API accepts 1 to 32 vCPUs and 1024 to 1048576 MB — Kiln accepts 1 to 32 vCPUs, and a guest with less than 1024 MB cannot run `npm ci`.
- Factoree does not check the size against the Kiln host — Kiln does not report host capacity.
- The sandbox fields show one line: memory × max live must fit the memory of the Kiln host — Kiln does not refuse an overcommit, and the host kernel then stops a VM.
- `docs/quickstart.md` recommends a max live of 6 for the Scaleway Start-2-L — 6 × 4096 MB leaves headroom in 32 GB, and 6 sandboxes carry 3 runs.
- The Kiln template name is the image digest plus the size, for example `factoree-59caf56b5b926bf9-4c-4096m` — a size change then builds a new template and leaves the old one alone.
- The sandbox exposes its template name, and the `WarmSnapshot` column `image` becomes `template` — a run reuses a warm snapshot only when the template name matches.
- The migration fills `template` with the template name of each row's image at 2 vCPUs and 4096 MB — that is the size the snapshot holds, so the first run at the new default starts cold and does not fork a 2 vCPU snapshot.
- Factoree never deletes an old Kiln template — a run in flight can still use it. The operator removes old templates in Kiln.
- A run in flight keeps its work sprite at the old size, and its next check sprite gets the new size — Kiln cannot resize a live sandbox.
- The local sandbox provider ignores the size.

## Out
- A size per repository or per product.
- A disk size setting.
- A check of the size against the Kiln host.
- Deletion of old Kiln templates or of warm snapshots of an old size.

## How I know it works
- `just verify` passes.
- The same probe of c-dash (`npm ci`, a cold `next build`, the type-check) takes less time at 4 vCPUs than at 2 vCPUs.
- /setup and the settings page show the vCPU and memory fields and the host memory line, and a saved value reads back.
- After a size change, Kiln lists a template whose name ends in the new size, and the next c-dash run logs a cold start.
- Kiln shows the sandboxes of that run at the new size, and the run after it forks the new warm snapshot.
