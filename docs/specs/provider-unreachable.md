# Provider unreachable

Amends [agent-session-usage-and-hangs](agent-session-usage-and-hangs.md) and SDD §50 (failure handling). Closes GitHub issue #61.

## What it does
A transient failure to reach the model provider from inside the sandbox, for example a DNS lookup that answers `EAI_AGAIN`, used to end the run as `IMPLEMENTATION_FAILED` after the CLI spent about 6.8 minutes in its own backoff, with 0 tokens used and no cause in the post. Factoree now classifies the failure, ends the session early, retries it, and names the cause when the run fails.

## Decisions
- The runner scans the output of a session that did not finish for `EAI_AGAIN`, `ENOTFOUND`, `ECONNRESET`, `ETIMEDOUT` and `Can't reach the API server`. A match sets `failureKind: "PROVIDER_UNREACHABLE"` on the result, and the summary keeps the API error text. — The cause is in the output, and the runner is the one place that reads it.
- When the end of the output shows only such an error for `PROVIDER_UNREACHABLE_GRACE_MS` (60 seconds), the runner cancels the process and returns the result at once. Output that goes on with other text resets the timer. — The grace is far under the backoff of the CLI, so the budget stays for the retry.
- Retry ladder, per step and per role: the first failure starts a fresh agent session in the same sandbox; the second starts a fresh session in a fresh sandbox; the third ends the run with `PROVIDER_UNREACHABLE`. — A fresh session fixes a stuck CLI, and a fresh sandbox fixes a resolver fault of one sandbox.
- The fresh sandbox applies to the Implementer, and only while no repair has run, because a fresh sandbox starts from the base commit and would drop earlier work. The Refiner, the User Validator and the Reviewer start a fresh session on the second retry too: their sandboxes hold no agent state to lose, and the check sandbox is rebuilt by its own activity. — Dropping work is worse than reusing the sandbox.
- A retry never uses the repair budget, unlike a hang. The Implementer retry raises the attempt number so its rows stay distinct, and the other roles carry `unreachableRetry` into their row keys and file names. — A provider fault is not a fault of the change.
- The failure reason `PROVIDER_UNREACHABLE` has the new category `INFRASTRUCTURE`. — It stays off the `AGENT` panel, because the agent did nothing wrong.
- The failure message names the role and the agent error, for example `API Error … EAI_AGAIN`. The `IMPLEMENTATION_FAILED` message now carries the agent output too. — The Proof Pack and the Linear post show the cause without opening Temporal.
- `AgentSession.outcome` gets the value `unreachable`, and the role totals count `unreachable` beside `hung`. — No migration: the column is a plain string.
- The workflow gates the new paths with the patch `provider-unreachable`. — A running history replays as before.

## Out
- The root cause of the sandbox resolver or egress fault.
- The mismatch between the stage duration and the session duration.
