# Check isolation

Amends `docs/factoree-sdd.md` §32, §35, §36, §40, §44 and §52.

## What it does
The implementer works in the work sprite of the run. After each implementer attempt, Factoree captures the patch and builds a new check sprite from the base SHA plus that patch. Deterministic verification, user validation and review run in the check sprite, in that order. Nothing the implementer did outside the patch reaches a check.

## Decisions
- Patch capture runs `/usr/bin/git` with a minimal environment (`PATH=/usr/bin:/bin`, a temporary HOME, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`) — an agent can write to every directory on the sprite PATH.
- Factoree hashes the patch at capture. The check sprite applies the patch with the same pinned options and must reproduce the hash — the patch is the only channel from the work sprite.
- Each attempt gets a new check sprite. The next attempt deletes the previous one, and the terminal write deletes the last one — a check sprite of an earlier attempt may hold a compromised validator.
- The check sprite runs the bootstrap command and the network policy of the work sprite — the checks need the same toolchain and no wider egress.
- Factoree runs git as `/usr/bin/git` with no user config, and with the repository filter, monitor and hook settings switched off — a shim in a user directory cannot replace it. Runner CLIs in a root-owned directory need a Sprite image change (B-2).
- Factoree records the patch hash before any project code runs in the check sprite. Publication captures the patch from the check sprite again and must reproduce that hash — the published change must be the change that verification tested. A change by the bootstrap, a check or an agent fails the run at publication and publishes nothing.
- A patch that changes a check-defining file is marked. Check-defining files are the verify and bootstrap commands, package scripts, test runner configuration and CI files. A marked patch opens a draft pull request, and the proof pack lists the files first — a patch can weaken a check that the base SHA defined.
- The published patch is the captured patch. The trusted checkout passes git only PATH, a temporary HOME and the scoped token — the worker environment holds the App key and the secret key.
- §52 "one run, one unique mutable sprite" becomes one work sprite per run plus one check sprite per attempt. No sprite serves two runs.

## Out
- Checkpoint restore in the work sprite. The SDK restore is not proven.
- A separate sprite for each agent role in the check stage.
- Network isolation between the validator and the reviewer inside one check sprite.

## How I know it works
- An implementer that writes a fake npm script to `/home/sprite/.local/bin/npm` that exits 0 does not change the verification result. A failing test still fails the run.
- A run with one repair logs one work sprite and two check sprites. Verification of attempt 2 runs in the second check sprite, and the first one is deleted.
- A user validator that edits a source file fails the run at publication with PATCH_HASH_MISMATCH, and no pull request exists.
- A patch that sets `"test": "true"` in package.json opens a draft pull request, and the proof pack lists package.json first.
- The trusted checkout git process environment holds no GITHUB_APP_PRIVATE_KEY and no FACTOREE_SECRET_KEY.
