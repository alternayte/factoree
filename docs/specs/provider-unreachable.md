# Provider unreachable

Amends [agent-session-usage-and-hangs](agent-session-usage-and-hangs.md) and SDD §50 (failure handling). Closes GitHub issue #61.

## What it does
A transient failure to reach the model provider from inside the sandbox, for example a DNS lookup that answers `EAI_AGAIN`, used to end the run as `IMPLEMENTATION_FAILED` after the CLI spent about 6.8 minutes in its own backoff, with 0 tokens used and no cause in the post. Factoree now classifies the failure, ends the session early, retries it, and names the cause when the run fails.

## Decisions
- The runner scans the output of a session that did not finish, line by line, for the agent CLI's own provider error: a line that carries the CLI marker `API Error` together with a connectivity code (`EAI_AGAIN`, `ENOTFOUND`, `ECONNRESET`, `ETIMEDOUT`), or the opencode phrase `Can't reach the API server`. A match sets `failureKind: "PROVIDER_UNREACHABLE"` on the result, and the summary keeps the API error text. — The cause is in the output, and the runner is the one place that reads it. A connectivity code on its own is not enough: `npm install`, a test, or a tool result that reaches a blocked egress host echoes the same codes, and those are ordinary failures, not a provider outage.
- When the last line of the output is such an error for `PROVIDER_UNREACHABLE_GRACE_MS` (60 seconds), the runner cancels the process and returns the result at once. A later line that is not a provider error, including a tool result that merely echoes a connectivity code, resets the timer. Stdout and stderr are judged separately, and blank-only output counts as none. — The grace is far under the backoff of the CLI, so the budget stays for the retry, and a healthy session that logged a tool's `ETIMEDOUT` before a long quiet turn is not cancelled.
- Retry ladder, per step and per role: the first failure starts a fresh agent session in the same sandbox; the second starts a fresh session in a fresh sandbox; the third ends the run with `PROVIDER_UNREACHABLE`. — A fresh session fixes a stuck CLI, and a fresh sandbox fixes a resolver fault of one sandbox.
- The fresh sandbox applies to the Implementer, and only while no repair has run, because a fresh sandbox starts from the base commit and would drop earlier work. The Refiner, the User Validator and the Reviewer start a fresh session on the second retry too: their sandboxes hold no agent state to lose, and the check sandbox is rebuilt by its own activity. — Dropping work is worse than reusing the sandbox.
- A provider failure that follows the one fresh session after a hang gets its own retries. Their numbers follow those of the first series, so no key or file repeats. — The hang recovery stays at one, and an outage is not read as three failures after one.
- The fresh sandbox is rebuilt from the effective work input of the Run, with the PR head and the merge flag of a PR follow-up run. — A rebuilt sandbox must hold the same change as the one it replaces.
- A retry never uses the repair budget, unlike a hang. The Implementer retry raises the attempt number so its rows stay distinct, and the other roles carry `unreachableRetry` into their row keys and into the names of their proposal, plan and report files, so a retry never reads the output of a rejected session. The Refiner and the Validator send no missing-output reminder once the provider is unreachable. — A provider fault is not a fault of the change.
- The failure reason `PROVIDER_UNREACHABLE` has the new category `INFRASTRUCTURE`. — It stays off the `AGENT` panel, because the agent did nothing wrong.
- The failure message names the role and the agent error, for example `API Error … EAI_AGAIN`. The `IMPLEMENTATION_FAILED` message now carries the agent output too. — The Proof Pack and the Linear post show the cause without opening Temporal.
- `AgentSession.outcome` gets the value `unreachable`, and the role totals count `unreachable` beside `hung`. — No migration: the column is a plain string.
- The workflow gates the new paths with the patch `provider-unreachable`. — A running history replays as before.

## Out
- The root cause of the sandbox resolver or egress fault.
- The mismatch between the stage duration and the session duration.
