# Check faults

Amends `docs/factoree-sdd.md` §36, §38 and §42, `docs/specs/run-recovery.md` and `docs/specs/by-eye-criteria-and-selector-recheck.md`. Closes GitHub issues 47, 48 and 49.

## What it does
A correct change no longer fails validation because a check is wrong. A browser text check waits for asynchronous text, as Playwright does. A criterion that needs an earlier action or a wait gets a check method that can prove it: an HTTP check can now send setup requests and poll. An assertion that passed in an earlier attempt and fails in a later one, while the reviewer passes the change, is unstable and spends no repair. The run then publishes a draft pull request that names it, as a run with unstable assertions does today.

## Decisions
- `expectText` retries until the element contains the text or the step timeout ends, as `expect(locator).toContainText()` does. The failure reason gives the last text seen and the time waited — an asynchronous state otherwise passes or fails on timing (#47).
- The validator prompt says that `expectText` and `expectVisible` wait up to the step timeout, so a plan needs no workaround for an asynchronous state.
- The refiner prompt says that a criterion triggered by a page action, such as a click, a fill or a page load, freezes as `browser`. A criterion that needs earlier requests or a wait, with no page action, freezes as `http` or `command` — the method freezes before implementation, so a wrong one leaves no valid plan (#48).
- An `http` plan entry holds `requests`, an ordered list of 1 to 5 requests. Every request except the last is a setup request and must answer with its `expectStatus`. The last request is the check — API-only criteria get HTTP evidence and no hidden curl script.
- The check request can hold `poll: { timeoutSeconds, intervalSeconds }`. Factoree sends it again until the status and the body match, or the timeout ends. `timeoutSeconds` is at most 120 and `intervalSeconds` at least 1 — "once the round trip completes" needs a wait with a fixed end.
- An entry with one request and no poll is the existing `http` entry. A plan of an older run still parses.
- The HTTP evidence records each request, its status, the number of polls and the time waited. The proof pack shows them in order.
- An assertion is UNSTABLE when all of these are true:
  - it passed in an earlier attempt of the same run
  - its plan entry is unchanged since then, compared by the hash of the entry
  - it failed in the current attempt, the rerun in the same check sprite included
  - the reviewer of the current attempt reports no blocking finding

  This is a deterministic rule on recorded results, so no agent decides the verdict (#49).
- The reason of such an assertion names the attempt where it passed and both failure reasons. It spends no repair, and the proof pack lists it first under Needs your attention — as for an unstable assertion in `run-recovery.md`.
- When every assertion that did not pass is UNSTABLE, the run publishes a draft pull request, as `run-recovery.md` already does. When a FAIL remains, the repair goes to the implementer with the FAIL findings only.
- The validator prompt says that each expect step asserts only the state that its criterion names — VAL-UI-007 asserted "sent" in a criterion about filters.
- No validator round may rewrite a check after a failure, except the existing selector re-check — a check rewritten after the agent has seen the failure is an agent claim deciding the verdict.

## Out
- A validator correction round for check faults beyond selectors.
- A deterministic lint for expect steps that assert more than the criterion.
- An UNSTABLE result for `command` and `test` entries that flip across attempts.

## How I know it works
- A browser scenario whose text appears 10 seconds after a click passes with the default limits. A scenario whose text never appears fails after the step timeout, and its reason names the last text seen.
- A criterion like FAC "after POST /orders, GET /orders lists the order once confirmedAt is set" freezes as `http`. Its plan holds a POST setup request and a polled GET, and it passes against a correct change.
- A criterion that names a click freezes as `browser`.
- A run where VAL-UI-002 passes in attempt 1 and fails twice in attempt 2, with no blocking finding, shows VAL-UI-002 as UNSTABLE, spends no repair on it, and publishes a draft pull request that lists it first.
- `just verify` passes.
