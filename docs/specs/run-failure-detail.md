# Run failure detail

Amends SDD section 48 (the terminal states of a Run) and section 49 (a configuration fault ends the Run in `FAILED_CONFIGURATION`).

## What it does
A Run that ends `CONFIGURATION_INVALID` or `INTERNAL_ERROR` keeps the cause. Its failure message and its Linear error hold the redacted error text of the step that failed. A Run that ends `INTERNAL_ERROR` posts its error to the Linear agent session. The compose install keeps closed Temporal workflows for 7 days.

## Decisions
- A `CONFIGURATION_INVALID` failure message is the fixed sentence of its step, then "Cause: " and the error text of the activity — the fixed sentence says what to repair, and the error text says what failed, such as the bootstrap exit code and its output tail.
- This applies at every `CONFIGURATION_INVALID` site of the agent run workflow: context, sandbox, refiner, check sprite, user validator, reviewer and publication — one rule, no site keeps the bare sentence.
- The workflow takes the error text from the first `RunConfigurationError` in the cause chain of the activity failure — the outer Temporal failure says only "activity task failed".
- An `INTERNAL_ERROR` Run stores the failure message "Factoree stopped the Run because of an internal error. Cause: " and the error text of the failure — the row has had no message.
- The `completeRun` and `postError` activities pass the failure message through the worker `Redactor` before they store or post it — the workflow holds no secrets, and a bootstrap output tail can hold one.
- The error text holds at most 2,000 characters. A longer text keeps its last 2,000 characters after "…" — the failing line is at the end of an output tail.
- An `INTERNAL_ERROR` Run posts one Linear error activity with its failure message and the follow-up reply prompt that every other failed Run posts — the person who delegated the issue sees that the Run ended.
- The post goes through `notify`, so a Linear failure never blocks the terminal write.
- The run page shows the failure message as it does now — no UI change.
- `deploy/compose/compose.yml` sets `DEFAULT_NAMESPACE_RETENTION: 7d` on the `temporal` service — `auto-setup` registers the default namespace with 1 day of retention otherwise.
- A one-shot `temporal-retention` service in the same compose runs `temporal operator namespace update -n default --retention 7d` from the `auto-setup` image after `temporal` is healthy — `auto-setup` reads the variable only when it creates the namespace, so an existing install needs the update, and a repeat changes nothing.
- The live install runs `maxConcurrentRuns` 2 on factoree-test, set on 2026-11-09 — 4 Runs and their check sprites ask for about 48 vCPU on the 12-core Dedibox.

## Out
- A run event log table or page.
- Full stdout and stderr of a failed step.
- A Factoree limit on live sandboxes or vCPU.
- Pacing the delegation of app-change issues.
- Temporal retention in the Helm chart, which uses an external Temporal.

## How I know it works
- Delegate an issue on a repository whose bootstrap command exits 1: the run page and the Linear error say "Cause: the bootstrap command failed with exit code 1:" and the output tail.
- `npm run test:workflow` with an activity that throws a plain error: the Linear post reads "Factoree stopped the Run because of an internal error. Cause: …", and the run row holds the same message.
- `temporal operator namespace describe -n default` on a new compose install shows a retention of 7 days.
- Open Temporal on the live install 3 days after a Run ends: its workflow is still listed.
