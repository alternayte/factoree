# Build prompt

Use this prompt at the start of each build session. The repository holds all state. Do not depend on earlier chat context.

## Start procedure

Do these steps in sequence.

1. Make sure that the current directory is the repository root and that `docs/factoree-sdd.md` exists.
2. Read `AGENTS.md`, `docs/build/handover.md` and `docs/build/decisions.md`.
3. Read each spec in `docs/specs/` that the handover names as current work. Read the SDD sections that the spec amends.
4. Run `git status` and `git log -10 --oneline`. Continue uncommitted work of the current item. For other uncommitted changes, do not change them. Stop and report them.
5. Read "Work queue" in the handover. Continue at the first item that is not DONE.

## Work loop

For each item:

1. Set the item to IN_PROGRESS in the handover. Commit.
2. Write the test first when the item changes behaviour that a test can pin. Run it and make sure that it fails for the expected reason.
3. Write the smallest correct code. Follow `AGENTS.md`. Add an abstraction only when a second use exists.
4. Run the narrow test, then `npm run lint` and `npm run typecheck`.
5. Commit with a clear message in ASD-STE100 style.
6. Set the item to DONE in the handover, with the commit and the test names. Commit.

After each spec or each group of small items: run `just verify`, fix every failure, and record the result in the handover.

## Rules

- **Authority.** The SDD decides, and a spec in `docs/specs/` amends it. Record each decision that neither settles as a DI entry in `decisions.md`.
- **Undecided forks.** A fork is major when a defensible answer changes the data model, a public API, security or what is out of scope.
  - Owner present: use the `grill` skill. Record the answer in "Human answers".
  - Owner not present: write a B entry with the options and your default. Build the default when it is the safe direction. Otherwise continue with other items.
- **Gates.** Do not weaken a gate, a test or a lint rule. Do not skip a test. Never run two test suites at the same time.
- **No placeholders.** No stub, TODO, "not implemented" or dead code path on a production path.
- **Live services.** `just live` and a live Sprite create real Sprites, Linear issues and GitHub pull requests. Run them only for an item that needs live proof.
- **Commits.** Commit after each item. Never push without the owner.

## Wind-down

When the context or usage limit is near:

1. Finish the current small change, or revert it so that the tree is clean.
2. Commit.
3. Write "Next step" in the handover as one exact sentence that a new session can act on.
4. Stop with a session report: items that changed status, the last `just verify` result, open B entries.
