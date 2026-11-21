# Sandbox memory and size

Amends `docs/specs/kiln-sandbox-size.md` (the size becomes a repository minimum on top of the provider size, and the disk becomes part of the size), `docs/specs/sandbox-provider-spillover.md` (held slots also count memory) and `docs/specs/repository-setup-and-services.md` (setup measures peak memory and disk).

## What it does
Factoree detects a check that the kernel killed out of memory, or that hit a full disk, on Kiln and on E2B. It records the fault as a sandbox fault and spends no repair. The run ends FAILED_CONFIGURATION, and Factoree starts a setup run of the repository with the fault as input. The setup measures the peak memory and disk of its proof and proposes a `sandbox` minimum or service caps in its pull request. A repository with a larger minimum gets sandboxes of that size, on a provider whose maximum and memory budget fit it.

## Decisions
- The Sandbox port gets `kernelLog(ref)`, as `egressLog` — rootless Docker runs without cgroups (`sandbox/factoree-docker-start`), so the kernel log is the only proof of an out-of-memory kill.
- Kiln adds `GET /v1/sandboxes/{id}/console?lines=N` (alternayte/kiln issue 33), the tail of the `console.log` it already writes for each VM — Kiln reads it outside the guest, so the agent cannot hide or fake it, and the guest gets no new privilege.
- The E2B adapter reads `/dev/kmsg` through its root exec — E2B already runs root commands for the DNS log.
- Factoree calls the route only for a sandbox it holds, so a 404 means a Kiln without the route. That Kiln makes `kernelLog` report "kernel log not available", and exit 137 stays `command_failed` with that note — Factoree does not guess an out-of-memory kill.
- Factoree reads the kernel log after a Factoree check exits 137 or its output holds `ENOSPC` or "No space left on device" — a passing run pays nothing.
- Exit 137 of a check that Factoree did not stop or time out, with an "Out of memory: Killed process" line in the kernel log of that sandbox, is out of memory — exit 137 alone can also be a stop, and a sandbox fault ends the run, so a sandbox holds at most one.
- The checks are the bootstrap, the services, the seed, the verify commands, the validator commands, the browser checks and the preview — an implementer session sees its own exit codes and keeps its repairs.
- The new run event kinds are `sandbox_out_of_memory` and `sandbox_disk_full`, with the stage, the command, the killed process, the kernel lines and the peak — the diagnosis names them.
- The fault spends no repair and ends the run FAILED_CONFIGURATION — a repair would change correct code.
- Factoree then starts a setup run of the repository with the fault event as input, unless one is open — the setup run is the one place that writes `.factoree/config.yaml`, as a pull request a human merges.
- The Linear failure post names the fault, the peak and the setup pull request, and says that a reply after the merge starts a follow-up run — a reply already starts one (DI-21.32).
- A guest sampler in the sandbox image reads `/proc/meminfo` (MemTotal minus MemAvailable) and `df` of the home each second and writes the peak used memory and disk to a file — Docker has no cgroup, so `memory.peak` is not available, and one read per second costs nothing that matters.
- Factoree starts the sampler at sandbox preparation, unless its pid file shows it running after a warm restore. It runs in each work sprite, check sprite and setup sandbox — the fault event and the setup report both need the peak.
- The setup report states the peak memory and disk of the proof next to the sandbox size.
- The setup agent (`setup@17`) first caps each service that takes a share of all memory by default: `MSSQL_MEMORY_LIMIT_MB` for SQL Server, `ES_JAVA_OPTS` for Elasticsearch and OpenSearch, the heap of Keycloak and Kafka — those fill any size, and a compose `mem_limit` has no effect without cgroups.
- The setup agent then writes `sandbox.memoryMb` or `sandbox.diskMb` when the peak is above 80% of the size: peak × 1.25, rounded up to 512 MB — a size at the peak fails on the next spike.
- `.factoree/config.yaml` gets an optional `sandbox: { vcpus, memoryMb, diskMb }`, each a minimum — the Codespaces `hostRequirements` precedent, and setup writes it from a measurement.
- Discovery stores the `sandbox` minimum on the repository row, as it stores the requested secret names — a run picks its provider and creates its work sprite before it reads `.factoree/config.yaml` in the sandbox.
- A run's size is the larger of the repository minimum and the provider size, per field. A change set uses the largest minimum of its targets — a set snapshot holds every target in one sandbox.
- Each provider gets an optional maximum: Kiln 32 vCPUs and its memory budget, E2B 8 vCPUs and 8192 MB unless the operator sets more — provider selection skips a provider below the minimum.
- No provider fits: the run ends FAILED_CONFIGURATION and names the minimum and each provider maximum.
- Each provider gets an optional `memoryBudgetMb` next to `maxLive`. A hold reserves 3 × the run's memory against it and 3 against `maxLive` — Kiln is limited by host memory, E2B by a sandbox count.
- The settings page shows the Kiln host memory next to the budget field — Kiln does not report its capacity.
- The Kiln template name holds the disk when it differs from 16384 MB, for example `factoree-<digest16>-8c-8192m-32768d` — a disk change then builds a new template, and the existing templates keep their names, so the upgrade starts no repository cold.
- The E2B adapter builds one E2B template per vCPU and memory size, named as the Kiln template. Factoree sets no disk on E2B — E2B sets the disk per plan, and disk-full detection covers it.
- A warm snapshot belongs to one template, so a repository at a new size starts cold once — Firecracker cannot restore a snapshot at another memory size.

## Out
- A memory grow of a live sandbox (Firecracker virtio-mem).
- A retry of the failed check at a larger size.
- A lighter stand-in service as a Factoree feature. The setup agent may still name one as an app change.
- Out-of-memory detection inside an implementer session.
- Operator-defined size classes.
- A size per product.
- A sandbox fault in a setup run starts no other setup run. The setup report names it.

## How I know it works
- `just verify` passes.
- On Kiln and on E2B, a verify command that allocates past the sandbox memory ends the run FAILED_CONFIGURATION with a `sandbox_out_of_memory` event that names the killed process, and the run records no `repair_started` event.
- The same run starts a setup run whose report names the peak memory and whose pull request adds `sandbox.memoryMb` or a service cap.
- After the merge and a reply, the follow-up run's sandboxes have the new size in Kiln (`kiln sandboxes list`) and in the E2B template, and the run passes.
- A verify command that fills the disk ends with `sandbox_disk_full`.
- On Kiln without the console route, the same exit 137 gives `command_failed` with "kernel log not available".
- With a Kiln budget of 24576 MB, a second run of an 8192 MB repository waits for a sandbox slot, or spills over to E2B.
