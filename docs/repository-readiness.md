# Repository readiness

This page tells you what a repository must hold before Factoree can work in it. It also tells you how to take a new app from a design doc to pull requests that Factoree verifies. A human can follow it. An AI assistant that helps a human can follow it too.

## The main rule

Factoree verifies a change with the checks of the repository. An empty repository has no checks, so Factoree has nothing to verify against. Do not delegate a whole new app to Factoree. A human makes the decisions that shape the app, in a skeleton. Factoree then builds the app one work item at a time.

## What the setup run needs

A setup run reads the repository and writes `.factoree/config.yaml`. Factoree then proves each part in a fresh sandbox (`docs/specs/repository-setup-and-services.md`). The setup agent writes `.factoree/**` only. It cannot change the app.

The skeleton must have these items. Without them, the bootstrap fails and the setup run opens no pull request:

- A committed lockfile for each package manager.
- A toolchain that `mise install` can install, such as a `.tool-versions` or a `mise.toml` file.
- One verify command that passes on a fresh clone, such as a lint, a typecheck or one test.

These items are optional in the skeleton. When the app needs one of them and does not have it, the setup report names it as an app change:

| Part | What the app must have |
|---|---|
| Verify commands | Lint, typecheck, test and build commands that run with no network access outside the allow list. |
| Services | A compose file in the repository for each service the app needs, such as PostgreSQL. |
| Seed | A command that creates the test data through the app's own code path. |
| Preview | A command that serves the app on a port. |
| Accounts | A sign-in path with local credentials, created by the seed. Factoree does not automate MFA or CAPTCHA. |
| External APIs | Nothing. Setup writes a fake for each external API that has no test secret in the product. |

When a setup pull request merges, Factoree creates and delegates a Linear issue for its app changes. The product setting **Issues per merged setup** decides if each change gets its own issue. When each app-change issue ends, Factoree runs the setup again. The skeleton therefore does not need every part. Factoree builds the missing parts as issues.

## What the skeleton must decide

The skeleton holds the decisions that are hard to change later. A human makes them, and an AI assistant can help:

- The language, the framework and the package manager.
- The directory layout and the module boundaries.
- The test runner and the lint and typecheck configuration.
- One gate command that runs every check, such as `just check`.
- CI that runs the gate on each pull request.
- One route or page that starts and responds.
- An `AGENTS.md` file with the stack rules and the domain words.
- The design doc, committed in `docs/`.

Keep the skeleton small. Each feature belongs in a work item, not in the skeleton.

## From a design doc to pull requests

Do these steps in this order:

1. Write the SDD. Review it with Speccy until the verdict is Build Ready.
2. Build the skeleton. Commit the SDD in it.
3. Install the Factoree GitHub App on the repository. The repository then shows on the product page with the badge **no config**.
4. Start a setup run from the product page. Fix each denied host and each failed part that the setup report names. Merge the setup pull request.
5. In Speccy, break the SDD into work items. Fix each MUST finding. Assign each work item to Factoree.
6. Push the breakdown to the Linear team of the product.
7. Factoree starts a run for each work item. A work item with a blocker waits until each blocker is completed or canceled.
8. Merge each pull request after review.
9. Run `speccy verify` on each pull request and its merge commit. The Speccy verify Action finds the work item from the Linear key in the pull request title.

## What a Speccy work item gives the refiner

The Speccy push writes these sections into the Linear issue:

- `Acceptance criteria`: each criterion quoted from the SDD, with its heading path. The refiner cites these quotes, so it does not drop them as new criteria.
- `Build answers`: the answers that independent readers agreed on. The refiner can use them as determined proposals.
- `Open questions`: the questions that the SDD does not answer. When the code does not answer one, the refiner asks a question in Linear with a proposed answer, and the run waits for the reply. A question that stays unanswered ends the run with VALIDATION_MANUAL_REQUIRED.

Answer each open question in the SDD before you push. Then the refiner has fewer questions to ask, and the run needs fewer human steps.

## Two checks, two questions

Factoree and Speccy check different things. Neither check replaces the other.

- Factoree proves that the patch passes the checks of the repository and the frozen validation contract.
- `speccy verify` proves that the code covers each requirement of the SDD, by trace ID.
