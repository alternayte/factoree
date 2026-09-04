# GitHub App discovery wiring

**Document type:** Design specification
**Date:** 2026-09-04
**Status:** Approved, ready for an implementation plan
**Style:** STE100-style controlled English
**Follows:** `docs/superpowers/specs/2026-09-03-multi-repo-tenancy-design.md`
**Amends:** `docs/sdd.md` sections 15, 30, 46, 62, 64

---

## 1. Problem

The tenancy foundation is built and merged into a branch. It cannot complete a Run.

No wired path writes a `Repository` row. `RepositoryRegistry.upsert` has one caller,
`DiscoveryService.syncRepository`. That has one caller, the route `POST /webhooks/github`.
`buildServer` mounts that route only when `discovery` and `verifyGitHubSignature` are both
supplied, and `bin/api.ts` supplies neither.

So `RepositoryRegistry.listByProduct` returns an empty list. `selectTarget` then reports an
ambiguous target with no candidates, the workflow asks a human a question with an empty list, and
the Run ends in `TARGET_UNRESOLVED`. The refusal discipline holds. No Run succeeds.

Three faults sit behind that one:

1. No GitHub webhook signature verifier exists anywhere in the codebase.
2. `RepositoryDiscoveryClient` stores one token at construction. In a deployment with two
   installations, one tenant's token reads another tenant's repositories.
3. Specification section 8 of the tenancy design requires an installation change to refresh the
   repository list. The `installation` event handler parses the payload and discards it.

## 2. The credential problem this design solves

Factoree authenticates to GitHub today with a `Product` secret named `GITHUB_TOKEN`.

Discovery cannot use it. To read `.factoree/config.yaml` Factoree needs a credential. The
credential lives on the `Product` that the file names. Discovery is the step that decides which
`Product` the repository belongs to. The credential is therefore unavailable at the moment it is
needed.

A GitHub App resolves this. An installation access token is scoped to an installation, and the
installation is known from the webhook before any `Product` is.

## 3. Decisions

The human partner approved each decision below during brainstorming.

| Decision | Choice |
|---|---|
| Authentication | A GitHub App with installation access tokens |
| The `Product` `GITHUB_TOKEN` secret | Retired. One credential path, not two |
| Private key storage | An environment variable holding a base64-encoded PEM |
| Token cache | In memory, per process, refreshed under a five-minute margin |
| Structure | A `GitHubTokenProvider` port, mirroring `LinearTokenProvider` |
| Install-time sync | Read every granted repository, queued and rate-aware |
| Sync execution | A Temporal workflow, not an in-process loop |
| Scope | Discovery wiring only |

## 4. Scope

This design covers the credential model, webhook verification, route mounting, and the
install-time sync.

It does not cover two known gaps, each of which gets its own cycle:

- An agent-facing tool that calls `cloneSibling`. The gate is built, tested, and unreachable.
- Refinement proposing a target repository. Until it does, a `Product` with several repositories
  blocks on `BLOCKED_TARGET` once per Run and asks a human.

Neither depends on this work. Both are cheap once this lands.

## 5. Prior art inside this codebase

`src/domain/products/linear-token-provider.ts` already solves the same problem against a
different vendor. It holds refresh logic behind an interface, and an adapter takes the interface
rather than a raw token. That pattern is why the Linear side survived the tenancy rewrite without
a credential defect, while the GitHub side acquired one.

This design mirrors it.

## 6. Configuration

Three new environment variables. All three are required.

```text
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY      # base64-encoded PEM
GITHUB_WEBHOOK_SECRET
```

`GITHUB_TOKEN` leaves the `Product` secret store. `bootstrap.sh` stops setting
`SETUP_GITHUB_TOKEN`.

A PEM holds several lines. An environment file and a secret manager both carry one line more
reliably, so the value is base64-encoded. Factoree decodes it at load and passes the PEM string to
`node:crypto`. Nothing reaches the filesystem, and no volume mount is needed.

### App permissions

| Permission | Level | Purpose |
|---|---|---|
| Contents | Read and write | Read the configuration file. Clone. Push a branch |
| Pull requests | Read and write | Open the pull request |
| Metadata | Read | Mandatory for every App |

The App subscribes to `installation`, `installation_repositories`, and `push`.

## 7. The token provider

### The port

`src/domain/products/github-token-provider.ts`:

```typescript
export interface GitHubTokenProvider {
  tokenForInstallation(githubInstallationId: string): Promise<string>;
}
```

### The adapter

`src/adapters/github/app-token-provider.ts`:

1. Sign a JWT. RS256. `iss` holds the app id. `iat` is backdated sixty seconds against clock
   skew. `exp` is nine minutes ahead, inside GitHub's ten-minute ceiling.
2. Exchange it. `POST /app/installations/{id}/access_tokens` answers with a token and an
   `expires_at`.
3. Cache the token against the installation id. Refresh when under five minutes remain.

The JWT is signed with `node:crypto` rather than a new dependency. Factoree signs a payload it
authors itself. It never parses a token from an untrusted source. Signing is safe to write
directly. Parsing is not, and this design never does it.

### Rules

- A token never reaches a log, an error message, an evidence record, or the Proof Pack. An error
  carries the HTTP status and the installation id.
- A token is never stored at construction. The provider takes the installation id on every call.
  This makes the cross-installation defect unrepresentable rather than merely absent.
- The cache is process-local. The API and the worker each mint their own. Minting costs one call,
  and a shared cache would be shared mutable state across processes for no gain.
- Every minted token is registered with the `Redactor` for the Run before use. The token must
  never reach output by design. The redactor is the guarantee that survives a later edit.

### Call sites

`RepositoryDiscoveryClient`, `GitHubPullRequests`, the repository reader, and `checkout` stop
taking a token. Each takes the provider and an installation id. The next subsection says where that id comes from.

### Which installation a repository belongs to

A Run holds a tenant and a target `Repository`. It does not hold an installation id, and a tenant
can hold several `GitHubInstallation` rows. So nothing today tells `checkout` or publishing which
installation to mint a token against.

`Repository` gains one column:

```prisma
  // The installation that granted access to this repository. Discovery knows it at sync time.
  // A clone or a push mints its token against this installation.
  githubInstallationId String
```

Discovery sets it, because the webhook that triggers a sync names the installation. A migration
adds the column. The product is not in production, so existing rows are removed rather than
backfilled.

This also bounds a failure. A repository whose installation is later removed keeps a column that
names a dead installation, so the mint fails with a message naming it, rather than silently
falling back to another installation of the same tenant. A fallback here would be the same guess
the tenancy design exists to remove.

## 8. Webhook verification

Verification runs before any parse.

`POST /webhooks/github` reads the raw body, computes `HMAC-SHA256` over it with
`GITHUB_WEBHOOK_SECRET`, and compares the result against the `X-Hub-Signature-256` header with
`crypto.timingSafeEqual`.

A mismatch answers 401. A missing header answers 401. A length mismatch answers 401. None of them
does any work.

Two details decide whether this is correct:

- **The raw body, not the parsed one.** Fastify parses JSON by default. Re-serializing changes
  bytes, so a signature computed over the re-serialized form is a signature over something the
  sender never signed. The route needs a content-type parser that keeps the raw buffer. The
  Linear webhook route already solves this. Follow it rather than write a second mechanism.
- **`timingSafeEqual` throws when lengths differ.** Compare lengths first and answer 401. An
  exception here becomes a 500, which tells an attacker more than a 401 does.

## 9. Mounting

`discovery` and `verifyGitHubSignature` become required on `ServerDependencies`.

They were optional so the route could land before its dependencies existed. Optionality is what
let the route stay unmounted through fifteen tasks without a single test noticing. A required
field makes an unmounted route a compile error.

`bin/api.ts` constructs the token provider, a `RepositoryDiscoveryClient` over it, the
`DiscoveryService`, and the signature verifier.

One behaviour carries over unchanged. An unbound installation is not an error. The route logs a
warning naming the installation id and the account login, does no work, and answers 200. GitHub
must not redeliver an event Factoree deliberately ignored.

## 10. The install-time sync

The webhook cannot do this work. GitHub expects a response in about ten seconds. Reading a
configuration file from every repository of a large installation takes minutes.

The route verifies, binds or warns, answers 200, and starts a workflow.

```text
installation event
      |
verify, bind or warn, answer 200
      |
start SyncInstallationWorkflow, workflow id keyed on the installation id
      |
list granted repositories, paginated
      |
for each, with bounded concurrency: syncRepository
      |
log a summary: registered, skipped, conflicted
```

### Why Temporal

Temporal is already the durable orchestration layer, and SDD section 54 gives it active durable
workflow state. An in-process loop loses its work on a restart or a deploy, which is when a fresh
installation is most likely to be mid-sync. Temporal also supplies retry and backoff, which is
most of what a rate-aware queue is.

### Rate awareness

The activity reads `x-ratelimit-remaining` and honours `retry-after` on a 403 secondary limit.
Temporal's retry policy performs the backoff. The workflow holds no timing logic, so it stays
deterministic.

### Concurrency

A small fixed width, not one read per repository in parallel. One installation must not consume
the rate budget that an interactive delegation depends on.

### Idempotency

`syncRepository` upserts on `(tenantId, fullName)`. A Temporal replay or a redelivered event
costs one duplicate read and changes nothing. The workflow id is keyed on the installation id, so
a repeated `installation` event joins the running sync rather than starting a second one.

### A 404 is the normal answer

A repository without `.factoree/config.yaml` does not participate. `readConfig` already answers
`null` for an absent file and throws only on a real failure. That distinction separates "not ours"
from "GitHub is unwell", and the sync depends on it.

### Removal

`installation_repositories` with repositories removed marks each absent. The row stays. The Run
history stays.

## 11. Retiring the Product GITHUB_TOKEN

Four call sites change:

| File | Change |
|---|---|
| `src/activities/publishing.activities.ts` | Drop the descriptor lookup, the injection-mark check, and `secrets.get`. Its missing-secret error becomes a failed-mint error naming the installation |
| `src/domain/runs/checkout.ts` | Clone with a minted token through `credentialEnv`. The URL stays free of a credential |
| `src/adapters/github/github-pull-requests.ts` | Take the provider |
| `src/adapters/github/repository-discovery-client.ts` | Take the provider |

**Mint per operation, never per Run.** A Run can outlive a one-hour token. The clone at the start
and the push at the end each mint their own. No token travels across a Run, so no token sits in
workflow state.

**What stays.** The secret-kind and injection-mark rules of SDD section 30 govern test credentials
and runner credentials, and they stay. One name leaves the store. `GITHUB_TOKEN_PATTERN` in
`credential-formats.ts` stays and already matches the `ghs_` prefix of an installation token, so
redaction keeps working with no change.

**Migration.** The product is not in production. An operator deletes any existing `GITHUB_TOKEN`
row. No data migration is needed.

## 12. Failure behaviour

| Condition | Result |
|---|---|
| A bad or missing webhook signature | 401. No work |
| An unbound installation | Warn, no work, 200 |
| A token mint failure | The operation fails and retries. The error names the installation and the status |
| A repository with no configuration file | Skipped. Not an error |
| A privilege key in a configuration file | Conflict. Logged, naming the repository and the key |
| Two Products claiming one Linear team | Conflict. Logged, naming both slugs |
| A rate limit | The activity backs off. Temporal retries |

## 13. Testing

**Unit**

- JWT signing produces the header, payload, and signature GitHub's format requires.
- The cache refreshes under the five-minute margin. It does not wait for expiry.
- A mint failure names the installation and the status. It never names the key.
- Signature verification rejects a wrong signature, a missing header, and a length mismatch. It
  accepts a body and signature pair computed from a fixed secret.

**Integration**

- The route verifies before parsing, proved by a body whose signature was computed over different
  bytes.
- A bound installation writes a `Repository` row. An unbound one writes none and answers 200.

**Workflow**

- `SyncInstallationWorkflow` registers the participating repositories, skips the absent ones, and
  reports conflicts.
- A repeated `installation` event joins the running sync.

**Acceptance**

```text
AT-49  A GitHub App installation syncs every granted repository
AT-50  A wrong webhook signature answers 401 and does no work
AT-51  An unbound installation warns, does no work, and answers 200
AT-52  A token is minted per installation, never shared between two
AT-53  A Run clones and publishes with a minted token, and holds no Product GITHUB_TOKEN
AT-54  A rate limit backs off, and the sync completes
AT-55  A repository without a configuration file is skipped, not failed
```

## 14. Definition of done

A Linear issue delegated to a `Product` whose repository declares itself reaches a pull request,
with no `GITHUB_TOKEN` anywhere in the `Product` secret store.

That sentence is the acceptance of this design. The tenancy branch cannot satisfy it. This one
must.

## 15. Out of scope

An agent-facing tool for `cloneSibling`.

Refinement proposing a target repository.

Any change to the tenancy model itself.
