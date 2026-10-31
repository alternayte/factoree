# Proof Pack and visual evidence

Amends `docs/factoree-sdd.md` §24, §26, §32, §37, §39 and §47.

## What it does
The Proof Pack has a short body for humans and a linked `proof-pack.json` for agents. The body shows the status, what changed, links, the items that need a human, inline screenshots and one line per check. A run whose ticket changes something a user sees carries a browser assertion with a screenshot, captured by Factoree in the check sprite. When the pull request CI publishes a preview, Factoree adds its link to the Linear session after the run.

## Decisions
- Only Factoree captures visual evidence, in the check sprite, with Playwright on the worker — an agent claim is never evidence, and only the patch leaves the work sprite.
- The pull request preview from CI (Kiln or another tool) is a link for humans and never evidence — the patch can change the CI workflow that builds it.
- Factoree learns the preview URL from the GitHub `deployment_status` event. It accepts a success status only when the deployment SHA equals the published commit — a deployment is the GitHub object for "this commit runs at this URL", and Vercel and Netlify emit it too.
- The GitHub App reads deployments and subscribes to `deployment_status` — the event is the only input.
- The run does not wait for the preview. The webhook handler finds the run target by repository and SHA, stores the URL on the run target, and adds it to the session with `agentSessionUpdate` `addedExternalUrls` — a Linear activity cannot change, and a slow CI must not hold a run open.
- At publication, Factoree adds the pull request URL to the session `externalUrls` — Linear documents this as the link for a published pull request.
- The Proof Pack body holds, in order: the status line, a change description from the reviewer labelled as such, the pull request and preview links, "Needs your attention", inline screenshots with the video linked, one line per check, and a footer with run ID, autonomy level, repairs and the `proof-pack.json` link — a human reads the decision in seconds.
- "Needs your attention" lists non-blocking findings, marked check-defining files, manual items and missing visual evidence. It says "Nothing" when empty — the item that needs a human must not sit at the bottom.
- `proof-pack.json` holds the context contract, hashes, every assertion with its evidence, and the run metadata. Factoree uploads it to Linear, and `GET /admin/runs/:id` returns the same JSON — an agent reads typed data, not markdown.
- Each assertion appears once. The body holds no context list and no hashes — they move to `proof-pack.json`.
- Progress thoughts are one short sentence each, with no SHAs — the Proof Pack carries them.
- `EVIDENCE_STORAGE` defaults to `linear` — a `file://` link on the worker opens for nobody.
- The refiner marks each criterion `visible: true` when the ticket names a page, a screen or a UI element.
- For a visible criterion in a repository with a `preview` block, the gate requires a browser assertion with a screenshot, and a video when the plan has more than one interaction step — a visible change must not pass on unit tests alone.
- For a visible criterion in a repository with no `preview` block, the gate asks one Linear question: "Proposal: proceed with no screenshot, because the repository has no preview". A "yes" proceeds, and "Needs your attention" lists the gap — the human accepts the gap on purpose.
- In a work sprite whose repository has a `preview` block, Factoree installs agent-browser and chrome-headless-shell beside the bootstrap command, under the bootstrap policy plus a fixed Factoree list of install hosts. It waits for the install before the agent policy applies — the install hides behind the bootstrap, and no agent ever runs with the install hosts.
- The implementer prompt names agent-browser and the preview command. Nothing from its browser checks reaches the Proof Pack — a self-check makes the agent better, not the proof stronger.

## Out
- Visual evidence captured against the CI preview.
- A Factoree call to the Kiln API, or a Kiln key in Factoree.
- Reading the preview URL from a pull request comment or a commit status.
- A custom sprite image, and a run started from another sprite's checkpoint. Fly Sprites has neither. Kiln as a sandbox provider is alternayte/kiln#16.
- A browser tool on the worker for the implementer.

## How I know it works
- A c-dash ticket "Show the app version in the dashboard footer" produces a Proof Pack with an inline footer screenshot from the check sprite.
- The same run shows "Pull request" in the Linear session Open menu at publication, and "Preview" after the Kiln workflow ends.
- A deployment status for a SHA other than the published commit adds no link.
- The FAC-33 Proof Pack lists `tsconfig.tsbuildinfo` under "Needs your attention" above the checks.
- Every evidence link in the Proof Pack opens in Linear.
- `proof-pack.json` parses, and equals the `GET /admin/runs/:id` response.
- A visible ticket in the fixture repository, which has no `preview` block, posts the no-screenshot question before the implementer starts.
- An implementer `agent-browser open http://localhost:<port>` succeeds in the work sprite, and the Proof Pack holds no file from it.
