# Skill registry

Amends `docs/factoree-sdd.md` §16, §44, §47 and §55.

## What it does
A Product can name a skill registry. Factoree resolves the registry to pinned skill versions on the worker, checks each digest, and delivers the skills into the work sprite before the implementer starts. The run records the set, the resolution id and each skill version. After each session, Factoree reports the skills the implementer loaded, and at the end of the run it reports the outcome. The implementer can propose one skill per run, and Factoree sends it to the registry for human review. Skael is the first registry. The organization skills repository is the second source behind the same port.

## Decisions
- A `SkillRegistry` port in `src/domain` has two adapters: Skael, and the organization skills repository — the rule "no abstraction without a second concrete use" holds.
- The port has three operations: resolve and deliver, report signals, and submit a proposal. The organization skills repository reports no signals — a Git repository has nowhere to store them.
- A Product setting holds the registry kind (`skael`), the base URL and an optional set name — one set per Product, because only the implementer receives skills.
- The service key is the Product secret `SKILL_REGISTRY_KEY` — it never sits in the Product row, and the redactor knows it.
- A named set resolves through `GET /api/sets/{name}/resolve` and the bundle — Skael pins the versions and gives the resolution id.
- An empty set name means every released skill. Factoree reads `GET /api/sync/manifest`, downloads each version, and computes the resolution id with the Skael formula — Skael has no such set until skael-dev/skael#30 ships. Only the Skael adapter changes then.
- Saving the setting resolves once and refuses a registry that does not resolve. With an empty set name, a set-limited key fails here, and more than 50 released skills give a warning — a wrong setting fails at save time, not in a run.
- The worker downloads and checks every archive against its SHA-256. A mismatch fails the preparation — a skill that is not the pinned version never reaches an agent.
- The worker unpacks the skills into a Factoree-owned directory beside the organization skills checkout, outside the repository checkout — a registry skill never reaches `git status` or the verified patch.
- The precedence is repository, then registry, then organization skills repository. A name conflict is reported as SDD §16 requires — a repository skill is the most specific, and the registry holds versions that a person reviewed.
- `MAX_SKILLS` stays 50. The prompt lists 50 skills and states how many more are in the skills directory — the agent finds them with `ls` and `grep`, and every version stays pinned.
- A `run_skill` table holds one row per delivered skill: run, source, name, version, digest, and activated. `Run` gets `skill_registry_set` and `skill_resolution_id` — SDD §55 requires the record of what a run used.
- A skill is activated when a tool call input of the session names the absolute path of its `SKILL.md`, or a native skill tool names the skill. Both runners already parse their tool parts.
- After each session, one `POST /api/events/batch` reports the registry skills that the session activated, with role `implementer` and the run id as `external_run_id`. The Idempotency-Key is run, attempt and session — a Temporal retry never counts twice.
- At the end of the run, `POST /api/outcomes` sends the outcome, the repair count, the review verdict and the proof pack link — Skael compares versions from these.
- A registry error never fails a run after the preparation. The activity retries, then logs — signals are statistics, not evidence.
- The implementer may write one draft skill and a `RATIONALE.md` under `.factoree/skill-proposals/<name>/` in the work sprite. Factoree removes that directory from the captured patch — the pull request never contains it, and the patch hash stays reproducible (SDD §44).
- After the run ends, whatever the outcome, Factoree redacts the draft and submits it. Skael gets `POST /api/submissions` with the run id and the Linear run link. The organization skills repository gets a pull request — a person reviews the proposal in both cases.
- A submission refused at send time, for example a Skael 422 scan finding, appears in the proof pack and never fails the run.
- The proof pack lists each skill the run loaded, with its source and version. A registry skill links to its version page, and each proposal links to its review — a reviewer sees the outcomes per version beside the change.
- The sandbox gets no registry key, no registry egress, no Skael hooks and no Skael MCP — the worker holds the full tool record, and a skill fetched during a session is not pinned.

## Out
- Webhooks, including `set.changed` and `submission.decided`.
- A set per role, and skills for the user validator or the reviewer.
- A Product setting for the skill cap.
- Skills in the warm snapshot.
- A second registry kind besides Skael.

## How I know it works
- A Product with Skael and set `go-tools` runs. `run_skill` holds each skill of the resolution with its digest, and `Run.skill_resolution_id` equals the `X-Skael-Resolution` of the bundle.
- A Product with Skael and no set name gets every released skill. Its resolution id equals the SHA-256 of the sorted name, version and digest list from `/api/sync/manifest`.
- A bundle with one changed archive byte fails the preparation and names the skill.
- `git status` in the work sprite shows no registry skill. The verified patch contains no `.factoree/skill-proposals` path.
- With 70 released skills, the implementer prompt lists 50 and states that 20 more are in the skills directory.
- After a run that read one registry `SKILL.md`, the Skael skill page shows one automated activation from consumer factoree and the run outcome.
- A rerun of the event activity with the same key adds no activation in Skael.
- A run whose implementer wrote a proposal shows a pending submission in the Skael queue with the run link. The proof pack links it.
- With Skael stopped after preparation, the run finishes and publishes. The worker log names the failed report.
- Saving a set that does not exist returns an error, and the Product keeps its old setting.
- `just verify` passes.
