# PR feedback loop

Amends `docs/specs/pr-review-merge-and-deploy.md` (Decisions on the named reviewer setting, the triggers, plain comments, the limit and the L4 conditions, and Out), DI-19.04, DI-21.102, DI-21.107 to DI-21.109, DI-21.123 and DI-21.126.

## What it does
Factoree acts on the review of any review app on its pull request, with no product setting. It waits until the reviews of a head settle, then starts one PR follow-up run with the findings of every review app, failed repository CI checks, and human requests. A human with write access asks for a change by a mention on the PR, or by a reply in the Linear agent session. Factoree answers a question without a commit. At L4, Factoree turns on auto-merge only when every review app passed the head.

## Decisions
- A review app is a GitHub App, other than Factoree, that submitted a review on the pull request. Its check runs and commit statuses on the head are its verdict. — Detection covers humans and Factoree on the same repository with no setup.
- The product setting `prReviewer` goes away. A product deny list of app slugs mutes a review app. — A noisy app needs one off switch, not an allow list.
- The findings of a review app are its unresolved review threads on any head, the annotations of its newest check run on the head, and its review bodies on the head. — Sayso posts a still-open finding only once, and posts a finding outside the diff only as an annotation.
- A thread that Factoree answered, with no newer comment, is not triaged again. — One reason per finding is enough.
- After any review app event on the current head, the PR workflow waits until no review app check on the head is pending and no new review arrived for 2 minutes, at most 30 minutes. — One verified commit answers every reviewer of a head.
- A review app acts when its check on the head is `failure` or `neutral`, or when it has no check and leaves unresolved findings. The findings of an app whose check is `success` start nothing. — The reviewer's own verdict is the cheapest honest signal, and Sayso gives `neutral` for comment-mode blocking and for changes suggested.
- Finding triage filters every review app finding (SDD §41). — A bot finding is a claim, not evidence.
- A failed check on the current head from an app that is not a review app starts a PR follow-up run after settle. Its findings are the check output, its annotations and the job log tail. A check that also fails on the base commit starts nothing. It skips triage. — A CI failure is deterministic evidence and the repository's own gate.
- The proof pack names a failed CI check as a check that the `.factoree/config.yaml` checks do not cover. — The setup gap stays visible.
- The product setting "automatic follow-ups per PR" limits the PR follow-up runs from review apps and CI together, default 3. At the limit, Factoree posts "Needs your attention" in Linear and on the PR. — Two reviewers that disagree must not loop, and the cost stays bounded per product.
- A comment that mentions `@<factoree app slug>` from a user with write access is a human decision, in the conversation, in a review thread or in a review body. A "request changes" review stays a human decision. Factoree adds 👀 to the mention when it takes it. — A mention is an explicit order, and the reaction is instant feedback.
- A reply in the agent session while the pull request is open is a human decision on that pull request. Factoree comments on the PR with a link to the reply. — Linear is the home channel, and GitHub readers see why the commit came.
- A human decision skips triage, has no limit, and joins the settle of its head with the review app findings. — The human is the authority, and one run takes everything open.
- The refiner of a PR follow-up run decides whether a human decision asks for a change. A question that changes no criterion gets an answer, with files and lines, in its thread or in the agent session. The run then ends ANSWERED with no commit. — A question must not become a commit, and an answer needs no check sprite.
- Factoree replies in each thread that a run handled: a fixed finding gets the commit and one line, and a dropped finding gets the reason. Factoree never resolves a thread. — A resolve by Factoree satisfies a human's conversation-resolution rule, and Sayso reads a foreign resolve as resolved by a human.
- At L4, auto-merge needs every review app check on the verified head to be `success`, and no kept finding from a review app with no check. Otherwise the pull request stays open as at L3, and "Needs your attention" names the app. — Triage is an agent claim, and an unattended merge rests only on independent verdicts.
- The agent session gets one activity when a PR follow-up run starts (the trigger, who, and links to the threads), one when it publishes or answers (the commit, and fixed or dropped per finding), and the "Needs your attention" post. — The session is the log of Factoree's decisions, not a copy of the discussion.
- The proof pack lists no PR comments and no suggestions of a passed check. Deploy amendments stay. — GitHub holds the discussion, and the run page copy has no reader.
- The GitHub App manifest adds the events `issue_comment`, `pull_request_review_comment` and `pull_request_review_thread`, and Actions read. The product page names each permission an install has not accepted. — Without them, mentions, threads and job logs are invisible.

## Out
- Copying PR comments into Linear.
- Resolving review threads.
- A command word other than the mention.
- Acting on the findings of a review app whose check passed.
- Changes to Sayso. They go to the Sayso repository.

## How I know it works
- Sayso in comment mode reviews a Factoree PR with one blocking finding outside the diff. Its check is `neutral`. Factoree starts one PR follow-up run, and the run fixes the finding from the annotation.
- Sayso and Copilot review both comment on one head. One PR follow-up run starts after both finish, and one commit answers both.
- The blocking finding stays open after that commit. Sayso fails the new head, and the next PR follow-up run takes the finding from its unresolved thread.
- A Sayso check that passes with two nits starts nothing.
- A GitHub Actions test job fails on a Factoree PR and passes on the base. Factoree pushes a commit that makes it pass. The proof pack names the job as not covered by the config.
- A user with write access comments `@factoreetemp rename the prop to label`. Factoree adds 👀 and pushes the rename. A user with read access gets no run.
- `@factoreetemp why does this skip the cache?` gets a reply that cites a file and line. No commit appears. `SELECT status FROM run` shows ANSWERED.
- A Linear reply "use the shared button" while the PR is open pushes a commit, and the PR shows a comment that links the reply.
- A fourth automatic follow-up on one PR with the setting at 3 starts no run and posts "Needs your attention".
- An L4 PR with a Sayso check `neutral` stays open without auto-merge, and "Needs your attention" names Sayso.
- No thread on a Factoree PR shows "resolved by" the Factoree app.
