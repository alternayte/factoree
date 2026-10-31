# Factoree tests

This document gives the test layers, the release checks and the definition of done.

## Test layers

| Layer | Location | Command | Needs |
|---|---|---|---|
| Unit | `tests/unit` | `npm test` | Nothing |
| Integration | `tests/integration` | `npm run test:integration` | Docker. PostgreSQL runs in testcontainers. |
| Acceptance | `tests/acceptance` | `npm run test:integration` | Docker |
| Workflow | `tests/workflow` | `npm run test:workflow` | The Temporal test environment |
| Live | `tests/live` | `just live`, `just live-sprite`, `just live-local` | Real Linear, GitHub and sandbox accounts |

A test file named `at-NN-*` covers acceptance test AT-NN of SDD §64.

Never run two suites at the same time. The integration and the workflow suites share the Docker daemon and the ports.

### Integration

`tests/integration/playwright-browser-driver.test.ts` drives a real browser. Install Chromium once:

```sh
npx playwright install --with-deps chromium
```

### Live

`just live` runs the live acceptance scenario against every dependency of SDD §66. Only `just live` is SDD §66 proof. `just live-sprite` and `just live-local` use local infrastructure. A missing credential exits 78 with `BLOCKED_EXTERNAL`. [docs/live-acceptance.md](docs/live-acceptance.md) has the three paths.

## The gate

```sh
just verify
```

`just verify` runs each stage alone and reports an aggregate exit code: the migrations check, lint, typecheck, unit, build, integration and workflow. CI runs `npm run verify`, the migrations check and the upgrade test, the chart lint and an image build.

## Release checks

`checks/migrations.sh` compares each file under `prisma/migrations` of the latest release tag with the working tree. It fails when a released migration changed or disappeared. A deployment has applied a released migration already, so an edit reaches no database. With no release tag, it passes with a message.

`scripts/upgrade-test.sh` starts a PostgreSQL container, applies the migrations of the previous release tag, applies the migrations of the working tree, and checks that the database then matches `prisma/schema.prisma`. With no previous release tag, it passes with a message. `just upgrade-test <ref>` upgrades from any commit.

`just chart` lints and renders the Helm chart. `just image` builds the image as `factoree:dev`. Check it:

```sh
docker run --rm factoree:dev --version
```

## Definition of done

1. `just verify` passes.
2. A change to `prisma/migrations` passes `checks/migrations.sh` and `just upgrade-test`.
3. A change to `deploy/` passes `just chart` and `just image`.
4. A change that a test cannot cover is checked by hand against the real service, and the commit says how.
