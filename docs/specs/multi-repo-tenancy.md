# Multi-repository tenancy: Product, Repository, and Change Sets

**Document type:** Design specification
**Date:** 2026-09-03
**Status:** Built. Change Sets (sections 12 to 15, the multi-target rows of section 10, AT-44, AT-45) are Version 2, as SDD §4 and §71 state. A Version 1 Run has exactly one target repository.
**Style:** STE100-style controlled English
**Amends:** `docs/factoree-sdd.md` sections 15, 27, 29, 44, 45, 47, 48, 52, 53, 63, 64, 71

---

## 1. Problem

Today `Project` means two things at once. It is the business unit, and it is
one repository. `Project.primaryRepository` is a single string.

Routing uses `findByLinearTeam(tenantId, linearTeamId)` with `findFirst`, and
falls back to `findDefaultForTenant`. Three faults follow:

1. A Linear team that owns several repositories cannot work. Two `Project`
   rows on one team resolve to whichever row the database returns first. The
   wrong repository is chosen silently.
2. A microservice group duplicates its secrets, context sources, and policy
   once per repository.
3. A work item that needs a change in two repositories has no representation.

## 2. Decisions

The human partner approved each decision below during brainstorming.

| Decision | Choice |
|---|---|
| Entity model | Split `Project` into `Product` and `Repository` |
| Registration | A repository registers itself; Factoree discovers it |
| Routing key | The Linear team, which supplies the issue prefix |
| Routing failure | Refuse and ask the human. No default, no first row |
| Policy ownership | `Product` owns policy. A repository names secrets only |
| Discovery | GitHub App events, plus a read at the base commit per Run |
| Unknown product slug | Create a pending `Product` at autonomy L0 |
| Sibling access | Read-only, cloned on demand, gated and evidenced |
| Multi-repository writes | Build Change Sets now |
| Confident single target | Proceed, and post a notice in Linear |

## 3. Constraints

Factoree must need no configuration of its own for a new repository. A human
touches Linear and the target repository only. Secret values remain in the
Factoree store, because neither Linear nor the target repository can hold them
safely.

Backward compatibility is not required. The product is not yet in production.

## 4. Prior art

Backstage models `Domain > System > Component`. A `System` groups components
that serve one purpose. A `Component` is one repository. The declaration lives
in `catalog-info.yaml` inside the repository, and Backstage ingests it.
Renovate, Dependabot, and Argo CD use the same inversion.

Linear supports the same shape. A team key of one to ten characters plus a
sequence number forms the permanent issue identifier, such as `FAC-30`. A
Linear project is a cross-team grouping and gives no prefix. Linear's own
GitHub integration already links one team to several repositories.

Factory.ai answers the multi-repository question with a Knowledge droid, which
is a shared index. That is a context solution, not a tenancy model. Mastra is
an agent framework and has no equivalent boundary.

## 5. Entity model

`Tenant` is unchanged. One Linear workspace, one `Tenant`.

### Product

`Product` is the business unit. It owns the policy surface.

```text
Product
  id, tenantId
  slug                  # "checkout-platform", claimed by repositories
  name
  status                # pending | active
  linearTeamKey         # "PAY", for humans and for error messages
  linearTeamId          # required, unique per tenant
  defaultAutonomy       # L0 while pending
  riskCaps, actionPolicy, redactionRules
  maxRunMinutes
  secrets        -> ProductSecret
  contextSources -> ContextSourceConfiguration
```

### Repository

`Repository` is one repository. It owns mechanics only.

```text
Repository
  id, tenantId, productId
  fullName              # owner/repo, unique per tenant
  defaultBranch
  configSha             # the .factoree/config.yaml commit last read
  bootstrap, verify, preview
  runners, repairMaxAttempts
  requestedSecretNames[]          # names only, never values
  discoveredAt, lastSeenAt, absentSince
```

### RunTarget

`Run` carries one `productId`. Per-target facts live in a child entity, so a
single-repository Run is one row and needs no special case.

```text
RunTarget
  id, runId, repositoryId
  role                  # primary | secondary
  selectionReason
  baseSha
  patchSha256
  commitSha
  pullRequestUrl
  mergeOrder            # 1, 2, 3 ...
```

### Removed

`Project`, `ProjectSecret`, `Run.primaryRepository`,
`Project.referenceRepositories`, `findDefaultForTenant`, and the `findFirst`
inside `findByLinearTeam`. An external reference repository becomes an ordinary
context source.

### Boundary rules

A repository never writes a `Product` field.

A `Product` slug is claimed, not assigned. Several repositories that claim one
slug is the normal microservice case, not a conflict.

## 6. Repository declaration

`.factoree/config.yaml` gains an identity block and a secret request list. It
loses nothing.

```yaml
version: 1

identity:
  product: checkout-platform
  linear:
    teamKey: PAY

bootstrap:
  command: npm ci

verify:
  commands:
    - name: typecheck
      run: npm run typecheck

secrets:
  require:
    - STRIPE_TEST_KEY       # a name, never a value
```

Unknown keys fail validation, as they do today.

A file that sets autonomy, an action policy, a risk cap, a redaction rule, or a
secret value fails validation, and the error names the offending key. The file
sits inside a repository that Factoree agents write to, so it must never widen
a privilege.

A named secret is a request. The value lives in the `Product` secret store. An
unmatched name fails the Run with a clear message.

## 7. Configuration ownership

| Owner | Fields |
|---|---|
| `Product` | secrets, context sources, autonomy, risk caps, action policy, redaction, maximum Run minutes |
| `Repository` | bootstrap, verify, preview, runner choice, repair limit, requested secret names |

## 8. Discovery

Factoree subscribes to the GitHub App events `installation`,
`installation_repositories`, and `push`.

An installation change refreshes the repository list. A push that touches
`.factoree/config.yaml` on the default branch refreshes that repository's row.

A repository whose file disappears is marked absent, not deleted, so its Run
history survives.

A repository that claims an unknown product slug creates a `Product` with
status `pending`, autonomy L0, no secrets, and no context sources. It can
investigate and report, nothing more. An operator supplies secrets and sets the
status to `active` once.

Two repositories that declare a different product slug but the same team key
must not create two Products. Discovery creates the first, then refuses the
second, and records a binding conflict against that repository. The operator
resolves it by correcting one repository file. This keeps section 9 satisfiable,
because a team always maps to at most one Product.

At Run start Factoree re-reads `.factoree/config.yaml` at the base commit and
records its SHA on the Run. The Run uses that content, not the cached row. If
the identity block at the base commit names a different `Product` than the
routing table used, the Run stops and asks. This is stale-base discipline,
applied to configuration.

## 9. Routing

A caller never supplies a Linear team id. The admin API and
`.factoree/config.yaml` accept `teamKey` only. Factoree resolves the key to an
id once, at bind time, through the Linear API, then stores both. The id is
authoritative afterwards.

Linear guarantees that a key is unique inside a workspace, and a `Tenant` is a
workspace, so `(tenantId, teamKey)` resolves to one team.

Webhooks carry the team id, so runtime routing reads by id. There is no Linear
call on the hot path.

A team key rename does not break the binding, because the id is stable.
Discovery updates the stored key and records the change. A repository file that
names the old key resolves through the id and reports the drift as a warning.

A key that resolves to no team fails the bind, and the error names the key.

Resolution has one step:

1. Read the issue's team. It matches exactly one `Product`. Route there.
2. Anything else refuses. Factoree posts the reason and the missing binding as
   a Linear comment, and the Run ends in `BLOCKED_ROUTING`.

The team key is present on every issue, so no fallback chain is needed.

## 10. Target selection

Refinement proposes the target set and the merge order. It orders the set so a
provider merges before its consumer.

| Case | Behaviour |
|---|---|
| The `Product` holds one repository | Automatic. No gate. |
| Several repositories, one confident target | Proceed. Post a Linear notice that names the target and the reason. |
| Several repositories, an uncertain target | Stop with `BLOCKED_TARGET`. Resume on a Linear reply. |
| More than one target | Stop with `BLOCKED_TARGET`. The human confirms the set and the order. |

P-05 forbids a guess, not a decision. A determined single target with a
recorded reason is a decision. An ambiguous choice still stops.

After the Validation Contract is frozen, the target set is immutable for the
Run.

## 11. Run lifecycle

```text
Linear delegation
      |
resolve team key -> Product        ( refuse unless exactly one )
      |
read .factoree/config.yaml at base ( record configSha )
      |
refinement proposes the target set and the merge order
      |
notice, or human confirmation      ( see section 10 )
      |
freeze the Validation Contract     ( the set is now immutable )
      |
implement in one sandbox
      |
verify per target, then validate the set
      |
one review over the whole set
      |
bounded repair                     ( limit 2 for the set )
      |
publish N linked draft pull requests
      |
one Proof Pack
```

A routing failure ends the Run before any sandbox exists, so a misrouted issue
costs nothing.

## 12. Sandbox

One Sprite holds one working directory per `RunTarget`, each cloned writable at
its own base commit.

A repository in the `Product` that is not a target is absent at start. An agent
that needs one calls `clone_sibling`, which the Action Policy gates.

| Action | Result |
|---|---|
| Clone a sibling member repository, read-only | allow |
| Write a sibling member repository | deny |
| Clone a repository outside the `Product` | deny |

Each sibling clone writes an evidence record that names the repository, the
commit, and the requesting role. The Reviewer therefore sees which siblings the
Implementer read.

## 13. Validation

One Validation Contract covers the whole set.

An assertion may name a target. An assertion may name no target when it
describes a behaviour of the `Product` as a whole, such as an end-to-end path
across two services.

Deterministic verification runs per target, with that repository's own `verify`
commands. User-level validation runs once, over the running set.

## 14. Patch integrity and publication

One patch record per `RunTarget`. `baseSha`, `patchSha256`, and `commitSha`
describe one target each.

Before publication Factoree re-checks every target's default branch. Any stale
target fails the whole Change Set, and no pull request is created. The Run ends
in `BLOCKED_STALE_SET`.

Publication is all or nothing. This is possible because publication happens
after every check has passed.

Each pull request is a draft, names the Change Set, links to its siblings, and
states the required merge order. Factoree does not merge.

A sibling that moves during the Run does not invalidate a patch, because the
Run never wrote to it. The sibling commit stays in evidence, so a later reader
can reproduce what the agent saw.

## 15. Review

One Reviewer session reads the combined diff across every target. A
cross-repository interface change is only correct when it is read as one
change.

A finding names a target. Scope control is unchanged.

The repair limit is 2 for the Change Set, not 2 for each repository.

## 16. Risk and autonomy

The `Product` supplies the policy.

When targets carry different risk labels, the highest risk governs the whole
set. A Change Set never runs above the lowest ceiling among its targets.

## 17. Run states

```text
BLOCKED_ROUTING     no Product for the team, or two Products claim it
BLOCKED_TARGET      the target set needs human confirmation
BLOCKED_STALE_SET   a target moved during the Run
```

`BLOCKED_ROUTING` is terminal and needs an operator. `BLOCKED_TARGET` resumes
on a Linear reply, like the existing material-decision gate.

## 18. Proof Pack

The Proof Pack gains one section.

```text
### Routing
Product: checkout-platform
Linear team: PAY
Targets:
  1. acme/checkout-api @ 4f21c9e -> PR #812
  2. acme/checkout-web @ 88a0f2b -> PR #341
Merge order: checkout-api, then checkout-web
Sibling repositories read: acme/checkout-events @ 1b7d004
Selection reason: <recorded reason, or "sole member">
```

## 19. Administration API

```text
POST /admin/products
{ "slug": "checkout-platform", "name": "Checkout", "linearTeamKey": "PAY" }
```

The response carries `linearTeamId` for observability. No caller sends it.

A repository is read-only through the API, because discovery owns it.

## 20. Module changes

| Area | Change |
|---|---|
| `prisma/schema.prisma` | Add `Product`, `Repository`, `RunTarget`, `ProductSecret`. Drop `Project`, `ProjectSecret`, `Run.primaryRepository`. One migration, no shim. |
| `src/domain/projects/` | Becomes `src/domain/products/`. `project-registry` splits into `product-registry` and `repository-registry`. `secret-store` re-parents to `Product`. |
| `src/domain/routing/` | New. Team key to `Product`, target set selection, refusal rules. Pure functions, no input or output. |
| `src/adapters/github/` | New discovery client. List installation repositories, read the config file, handle the three events. |
| `src/domain/products/factoree-config.ts` | Add the `identity` block and `secrets.require`. Reject a privilege key by name. |
| `src/adapters/sandbox/` | One working directory per `RunTarget`. New `clone_sibling` action, gated and evidenced. |
| `src/domain/publishing/` | Patch integrity per target. Stale-base check per target. Linked pull requests with a merge order. |
| `src/workflows/agent-run.workflow.ts` | Routing step before refinement. Three new states. |
| `src/http/admin/` | `projects.routes.ts` becomes `products.routes.ts`. Accept `linearTeamKey` only. |
| Proof Pack | New `Routing` section. |

## 21. Acceptance tests

```text
AT-38  A team key resolves to one Product; the id never leaves Factoree
AT-39  Two Products that claim one team refuse with BLOCKED_ROUTING
AT-40  A repository file that sets autonomy fails validation by key name
AT-41  An unknown product slug creates a pending Product at L0
AT-42  A confident single target proceeds and posts a Linear notice
AT-43  An ambiguous target blocks with BLOCKED_TARGET and resumes on reply
AT-44  A two-target Change Set publishes two linked PRs in merge order
AT-45  One stale target fails the whole set; no pull request is created
AT-46  A sibling clone is read-only and writes an evidence record
AT-47  A clone outside the Product is denied by the Action Policy
AT-48  A team key rename keeps the binding and records the drift
```

## 22. Implementation order

1. Entities and routing. Every later step depends on this boundary.
2. Discovery, and the repository configuration schema.
3. The single-target path, end to end, on the new model. This restores today's
   behaviour.
4. Change Sets. These add per-target repetition to the sandbox, publishing, and
   review.

## 23. Out of scope

Automatic merge stays a non-goal. L4 stays reserved.

A Change Set spans one `Product`. A write outside the `Product` is denied.

Coordinated writes across tenants are not supported.
