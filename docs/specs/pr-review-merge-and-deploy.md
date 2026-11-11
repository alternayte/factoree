# PR review, merge and deploy

Amends `docs/factoree-sdd.md` §4, §27, §29, §45, §47 and §48, `docs/specs/autonomy-levels.md` (Out), and DI-19.04. Closes handover item H-16.

## What it does
Factoree works on its pull request after publication. A failed check from the PR reviewer, or a human "request changes" review, starts a PR follow-up run that pushes a new verified commit to the same branch. When the branch conflicts with its base, Factoree brings it current with evidence. At L4, Factoree turns on GitHub auto-merge, and the repository ruleset decides the merge. Repository CI deploys. Factoree reports each deploy result for the run in Linear and in the proof pack.

## Decisions
- The PR reviewer is an external review app, such as an org review bot. It is a product setting: the GitHub App slug and the check name. `.factoree/config.yaml` cannot set it. — The product owns policy, and a merged agent PR must not weaken its own gate (R-4).
- Factoree reads the PR reviewer verdict from its check run or commit status on the PR head. It never reads a verdict from comment text. A pending check means that the review is in progress. — A check is what GitHub gates on, and it can be pinned to its app.
- Only two things start a PR follow-up run. The first is a failed PR reviewer check, with that app's review comments on that head as findings. The second is a "request changes" review from a human with write access. — GitHub verdicts give one rule for a bot and a human. Nits and suggestions do not spend budget.
- A fresh reviewer session in a check sprite of the PR head triages the PR reviewer findings. It keeps only findings with a concrete defect, a rule and evidence (§41). Factoree replies on the PR to each dropped finding with the reason. — A bot finding is a claim, not evidence.
- A human "request changes" review is a decision. It skips triage and outranks every other sentence, as a Linear reply does. — The human is the authority.
- Plain comments, and suggestions on a passed check, start nothing. The proof pack lists them. — A human sees them without Factoree acting on them.
- A PR follow-up run targets the existing PR branch. It refines again with the review as decisions, freezes a new contract version, runs every check, and pushes one new verified commit. The proof pack names the contract version of the head commit. — The follow-up run already turns human input into a frozen contract (DI-19.04).
- Each PR has at most 3 PR follow-up runs from the PR reviewer. Human reviews have no limit. At the limit, Factoree posts "Needs your attention" in Linear and on the PR. — Two reviewers that disagree must not loop.
- Factoree brings a PR current in two cases only. The first is when GitHub reports a conflict. The second is just before an L4 merge, when the ruleset requires the branch to be up to date. — A check sprite runs only when the update changes an outcome.
- A clean update merges the base into the branch and never force-pushes. A check sprite runs the frozen contract with no agent. Factoree pushes the merge commit only after the contract passes. The verified patch becomes the diff from the new base to the new head. — A rebased tree meets the same evidence bar, and the review threads keep their place.
- A conflict, or a failed check after the update, starts a PR follow-up run with the conflict or the failure as a finding. — The implementer resolves code. Factoree does not.
- `PUT /admin/products/:id` accepts L4. Risk caps and the `factoree:l0` to `factoree:l2` labels still lower it. The default high-risk labels stay at L2. — A lower level stays the safe direction.
- At L4, Factoree turns on GitHub auto-merge when these conditions all hold: the risk cap allows L4, the Factoree checks passed on the head, the PR reviewer check passed (if the product names one), and no "request changes" review is open. — GitHub enforces its ruleset for every PR, so Factoree adds no second policy engine.
- A required human approval lives in the ruleset. Factoree cannot approve its own PR. A human turns off auto-merge to stop the merge. — Devops owns the merge gate, and the override is one click on the PR.
- Factoree merges with squash when the repository allows it. Otherwise it uses the first method that the repository allows. — One commit per work item on the base branch.
- A new verified commit turns auto-merge off, and Factoree turns it on again only when the conditions hold for the new head. — Auto-merge must never merge an unchecked head.
- In a change set, Factoree turns on auto-merge for a consumer PR only after every provider PR has merged. — The `factoree/change-set` order holds without a human.
- Publication starts one PR workflow per published PR, keyed by repository and PR number. It takes review, check, conflict, merge and deploy events. The run itself still ends at READY_FOR_HUMAN. — A terminal run frees its concurrency slot (DI-15.13).
- Factoree never deploys, never holds production credentials, and never approves or dispatches a deploy. Repository CI deploys, for example Pulumi in GitHub Actions with OIDC, on an environment whose required reviewers devops sets. — A deploy ships a whole commit of main, which Factoree did not fully check.
- Factoree reads deploys only from GitHub deployment events, so the deploy job must name an `environment:`. A deployment on a PR head stays the preview link. A deployment on a base-branch commit that contains the merge commit counts as a deploy of the run. Factoree records it once per environment. — Deployment events are the only signal that names an environment.
- A successful deploy posts the environment and the commit in Linear and in the proof pack. — This is the production feedback the architecture lists as missing.
- A failed deploy marks each run in its commit range and moves each Linear issue back from completed. It posts the environment, the commit range and the job log link. Rollback stays in CI. — A deploy log does not name its cause, so Factoree reports and does not revert.
- A human reply after a failed deploy starts a follow-up run with the deploy log as a finding. This extends DI-19.04, where a reply after READY_FOR_HUMAN starts nothing. — The human turns the evidence into a decision.
- The GitHub App manifest adds the events `pull_request_review`, `check_run` and `status`, and Checks read. An existing install must accept the new permissions. Until it does, Factoree states the missing permission on the product page. — Without the events, the PR workflow is blind.

## Out
- Automatic autonomy promotion from deploy results or reverts.
- Factoree as a deployment protection rule, and Factoree dispatching a deploy.
- Merge queue.
- Replies to plain PR comments, and `@factoree` commands on a PR.
- An automatic revert or fix-forward after a failed deploy.

## How I know it works
- A product names the PR reviewer. A Factoree PR shows the reviewer's check as pending, then failed with one real defect and one nit. Factoree replies to the nit with the reason it was dropped. A new commit on the same branch fixes the defect, and the proof pack names contract version 2.
- A human "request changes" review asks for a rename. Factoree pushes a commit with the rename, and nothing triages the review.
- A fourth failed PR reviewer check on one PR starts no run and posts "Needs your attention".
- A conflicting push to main moves the PR to conflict. Factoree pushes a merge commit after a check sprite passes, or starts a PR follow-up run when the merge conflicts.
- `PUT /admin/products/:id` with `"defaultAutonomy":"L4"` answers 200. A ticket labelled payments in that product still opens a draft PR.
- An L4 PR on a repository whose ruleset requires one approval shows "auto-merge enabled by factoree". It merges only after a human approves. The Linear issue moves to completed.
- The deploy job on `production` succeeds. The proof pack and the Linear session show `production` with the commit SHA.
- A failed `production` deploy moves the issue back from completed and posts the job log link. The reply "revert this" starts a follow-up run.
- `SELECT status FROM run WHERE id = $1` shows READY_FOR_HUMAN while the PR workflow is open in the Temporal UI.
