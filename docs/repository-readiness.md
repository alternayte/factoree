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

1. Write the design doc. Review it until a builder can build from it without questions to the author.
2. Build the skeleton. Commit the design doc in it.
3. Install the Factoree GitHub App on the repository. The repository then shows on the product page with the badge **no config**.
4. Start a setup run from the product page. Fix each denied host and each failed part that the setup report names. Merge the setup pull request.
5. Break the design doc into work items. Create each one as a Linear issue in the team of the product.
6. Delegate each work item to Factoree. A work item with a blocker waits until each blocker is completed or canceled.
7. Merge each pull request after review.
8. Check each merged pull request against the requirements of its work item.

[alternayte/speccy](https://github.com/alternayte/speccy) is one example of a tool that reviews a design doc, breaks it into work items, pushes them to Linear and checks the code against each requirement.

## What a work item needs

The refiner builds the validation contract from the issue text. A good work item has these properties:

- It quotes each acceptance criterion from the design doc, with the section it comes from. The refiner cites the quotes, so it does not drop them as new criteria.
- Each criterion is one that a test, a command, an HTTP request or a browser route can check.
- It changes one repository.
- It holds a small number of requirements.
- It uses a Linear "blocks" relation for each work item that must merge first.
- It has no open questions. When the code does not answer a question, the refiner asks it in Linear with a proposed answer, and the run waits for the reply. A question that stays unanswered ends the run with VALIDATION_MANUAL_REQUIRED.

## Two checks, two questions

Factoree and a check against the design doc answer different questions. Neither check replaces the other.

- Factoree proves that the patch passes the checks of the repository and the frozen validation contract.
- A check against the design doc proves that the code covers each requirement of the doc.
