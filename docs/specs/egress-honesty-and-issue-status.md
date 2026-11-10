# Egress honesty and Linear issue status

Amends SDD section 29 (egress), section 41 (review severity) and docs/specs/run-recovery.md.

## What it does
A run that needs a host outside its egress allow list stops and names the host. It does not work around the block. The refiner and the implementer see the allow list that applies to them, and the reviewer blocks a hand-built stand-in for a named tool. Factoree moves the Linear issue status by itself: to started when a run starts, to completed when its pull requests merge, and back to the previous status when a run ends without a pull request or every pull request closes without a merge.

## Decisions
- The refiner, implementer and user validator prompts state the effective allow list: the run's `allowedDomains` plus the agent hosts. They state that `bootstrap.allowedDomains` applies to the bootstrap only. — In FAC-101 both agents read the bootstrap list as allowed and called the block transient.
- The prompt states that a denied host can appear as a connection reset, a TLS error or a timeout, and is a policy block, not a transient fault. — E2B gives no egress log and resets a denied TLS connection (docs.e2b.dev, 2026-11-10).
- The refiner proposal and the implementer result carry `missingHosts: [{ host, reason }]`. — A named host is data Factoree can act on. A sentence in prose is not.
- The refiner lists a host under `missingHosts` and freezes no check that needs it. — The FAC-101 refiner froze `dotnet tool restore` after it saw nuget blocked.
- Factoree drops a named host that the effective allow list already holds. Any other named host ends the run as FAILED_CONFIGURATION, reason CONFIGURATION_INVALID. — The product owns the egress ceiling (R-4), so only a human can widen it.
- Factoree acts on `missingHosts` without other evidence. — A named host can only stop a run. It never passes one.
- The failure post names each host and its reason. It says where to add the host: the product allow list, and `sandbox.allowedDomains` when the repository declares a non-empty list. Then it asks for a reply. — A repository list narrows the product list, so an addition to one place alone can still deny the host.
- A reply starts a follow-up run (DI-21.32). The run does not resume in place. — A new sandbox gets the new allow list. Factoree adds no mid-run egress change.
- The reviewer reports a blocker when the change delivers a hand-built stand-in for a tool or package the work item names, or publishes a package under another project's id. The implementer prompt forbids both. — The reviewer rated the FAC-101 stand-in `csharpier` 1.3.0 as medium.
- When a run starts, Factoree moves the issue to the team's first `started` state by position. It does not move an issue in `triage`, `started`, `completed` or `canceled`. The run records the state it moved the issue from and the state it set. — Linear agent best practices (2026-11-10).
- A run that ends with no pull request moves the issue back to its previous state: FAILED, FAILED_REVIEW, FAILED_CONFIGURATION, STALE_BASE, CANCELLED, REPORTED and each BLOCKED status. A follow-up run moves it to started again. — Started means that Factoree works on the issue.
- When every pull request of a run merges, Factoree moves the issue to the team's first `completed` state. — A merge delivers the work item.
- When every pull request of a run closes without a merge, Factoree moves the issue back to its previous state and posts one line in the agent session. — A closed pull request rejects one attempt, not the issue.
- When some pull requests merge and others close, Factoree moves nothing and posts one line. — A human must judge a partial delivery.
- Factoree moves an issue only while it is still in the state Factoree set. — A human change of status wins.
- Factoree detects merge and close from the GitHub `pull_request` event, action `closed`, with `merged` true or false. It matches the event to a run target by repository and pull request number. The App manifest adds the event. — A close without a merge makes no push.
- docs/quickstart.md tells an operator with an App created before this release to subscribe the App to Pull request events. — The manifest applies only to a new App.
- When Factoree opens a pull request, it links the pull request to the issue as an attachment and adds its URL to the agent session `externalUrls`. — The issue shows its pull request without the Linear GitHub integration.

## Out
- No Factoree egress proxy and no egress log for E2B.
- No automatic widening of an allow list.
- No resume of a stopped run in place.
- No dependency on the Linear GitHub integration. No issue id in the branch name.
- No move to a `canceled` state. Only a human cancels an issue.
- No state for review, such as "In Review". The issue stays started while its pull request is open.

## How I know it works
- Remove `api.nuget.org` from the factoree-test allow list, then delegate a CSharpier issue on alternayte/anthology. The run ends FAILED_CONFIGURATION. The post names `api.nuget.org` and the product page. No pull request exists.
- Add the host back and reply in the session. A follow-up run starts, and its pull request uses the real `csharpier` package from nuget.org. No `NuGet.Config` with a local source and no `tools/csharpier` appear.
- The prompt files in `/home/agent/workspace/.factoree/prompt/` of a run list the effective allow list, and not the bootstrap list as allowed.
- Delegate a Backlog issue. It moves to In Progress within seconds of "Factoree accepted the work".
- Merge the pull request. The issue moves to Done, and the pull request shows as an attachment on the issue.
- Close a pull request without a merge. The issue returns to Backlog, and the session shows one line about the close.
- Move an issue to Todo by hand during a run, then let the run fail. The issue stays in Todo.
- `npm run verify` passes.
