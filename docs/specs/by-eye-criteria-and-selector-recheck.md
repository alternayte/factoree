# By-eye criteria and selector re-check

Amends `docs/factoree-sdd.md` §36 and §42, `docs/specs/refiner-agent.md` and `docs/specs/proof-pack-and-visual-evidence.md`. Issue #42.

## What it does
A criterion that a person judges by eye never becomes an automated pass or fail. Factoree captures a screenshot of its page and puts it in the proof pack for the human. Browser checks select by role, label, text or `data-testid`, never by styling class. A browser check that fails only on its selector gets one selector re-check before it counts as failed.

## Decisions
- A by-eye criterion ("follows the screenshot", "looks like", "is consistent with the brand") is `manual`, `visible: true`, with the page route as its target. The refiner prompt states this rule — no automated check can judge a look, and a brittle check burns the repair budget.
- The gate does not freeze a manual visible criterion with a route. It records it as "for your eye", not as dropped, and it is no visual evidence gap — the criterion still reaches the human, with a picture.
- After the validation plan of an attempt runs, Factoree loads each "for your eye" route in the check sprite and captures one screenshot. It signs in as the repository's first account when the repository defines one — Factoree owns the capture, so no agent writes a check that can fail.
- The proof pack lists each one under "Needs your eye", with its statement and the screenshot of the last attempt. It counts in no assertion total — it proves nothing by design.
- A failed capture is a line under "Needs your eye", not a run failure — the screenshot is a help for the human, not evidence.
- The refiner and the validator prompts forbid selectors on styling classes. They name role, label, text and `data-testid` as the allowed kinds — markup classes change on every repair.
- The plan check rejects a browser step whose selector holds a class selector (`.name`) or a `class` attribute selector. The rejection goes to the existing plan correction round (DI-15.23) — the validator fixes it before any check runs.
- A selector-only failure is a Playwright strict-mode violation, or a locator timeout on `click`, `fill`, `expectVisible` or `expectText`. The driver captures the page HTML at that step — the validator needs the real markup to correct a selector.
- When a browser entry fails only on its selector, and its rerun of `docs/specs/run-recovery.md` also fails, Factoree resumes the validator once per attempt. The validator gets the failed step, the error, the final screenshot and the page HTML — one bounded round, the same mechanism as the plan correction.
- The corrected entry may change only `selector` fields. Factoree compares it with the original entry and rejects any other change — a re-check must not weaken what the check asserts.
- Factoree runs the corrected entry. A pass is a pass on evidence. A fail is a real failure and starts a repair. The re-check uses no repair budget — a wrong selector is a fault of the check, and the corrected check still has to pass.

## Out
- Discounting a failed check because another check shows the element.
- Interaction steps before a by-eye screenshot.
- Image comparison against the work item's screenshot.

## How I know it works
- A work item with "The page follows the screenshot's colours" produces a proof pack with that statement and a screenshot under "Needs your eye", and no assertion for it.
- A validation plan with `span.rounded-full` goes to the correction round, and the corrected plan uses no class selector.
- A browser entry that fails with a strict-mode violation gets one selector re-check. The worker log shows the re-check and its result. The run's repair count does not change.
- A corrected entry that also changes an `expectText` value is rejected, and the original failure stands.
