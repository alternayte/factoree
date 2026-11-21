# Repository membership

Amends `docs/factoree-sdd.md` §15 and §64 (AT-41, AT-42), and `docs/specs/multi-repo-tenancy.md` §3.

## What it does
A repository that claims an active product through its `.factoree/config.yaml` does not join that product at once. Its membership is pending until a Linear workspace admin accepts it on the product page. A pending or rejected repository is never a run target, a sibling, a change set member or a build-ahead input, so it receives no product secret, runner credential or host credential. A claim that creates a new pending product attaches at once, and the activation of that product accepts its repositories. When an issue names a pending repository, the run posts a Linear notice that names it and links the product page.

## Decisions
- Only a claim on an active product is pending — a pending product holds no secrets and runs at L0, so its claims expose nothing, and activation is already the human decision.
- AT-41 stays: an unknown slug still creates a pending product — the zero-config path for a new product survives.
- The Repository row gets `membership` (`pending`, `accepted`, `rejected`), `membershipDecidedBy` (user id) and `membershipDecidedAt` — `@@unique([tenantId, fullName])` already gives one row per repository, so a second table adds nothing.
- One domain predicate, member = present and accepted, replaces each `absentSince === null` check that decides targets, siblings, change sets, setup candidates of other products, host credential git access, context sources and build-ahead — one rule in one place, so no reader forgets the new state.
- Accept and reject need a Linear workspace admin — `admin-guard.ts:71` already gates every product write this way.
- The product page lists pending and rejected repositories with Accept and Reject, the requested `secrets.require` names and the config commit. The products list shows a pending count — the admin sees what the repository asks for before trusting it.
- The activate dialog lists the repositories that activation accepts — the admin accepts them knowingly.
- A setup run that an admin starts from the product page accepts the repository when its config names that product — a human already chose the repository.
- A rejection stays while the config names the same product. A later push does not reopen it. An admin can accept it later — a rejected repository must not spam the page.
- A config that names a different product moves the row to that product and resets it to pending, if that product is active — the trust of one product does not carry to another.
- A config change that keeps the product needs no new acceptance — `secrets.require` filters no secret, and the repository's own branch protection reviews its bootstrap and allow list.
- Target selection posts the `notTargetable` notice when the issue text names a pending or rejected repository, or when a follow-up run or a PR follow-up run targets one — the issue author learns the reason, not a wrong target.
- Migration marks every existing repository `accepted`, with no decider — the live repositories already run, and the owner controls each one.
- Accept of a repository starts its build-ahead — the first run of a new member must not wait for a cold snapshot.

## Out
- A product-level allow list typed by hand. The config claim stays the only source of membership.
- Filtering secret injection by `secrets.require`.
- Recovery of a team that a pending product squats. The existing conflict refusal stays.
- A Linear issue or an email for each claim.

## How I know it works
- Push a config that names `factoree-test` to a new repository. The product page shows it as pending, and the products list shows 1 pending.
- Delegate a FAC issue that names that repository. The run does not target it. Linear shows a notice that names it as pending, with a link to the product page.
- A Linear workspace member who is no admin gets 403 on Accept.
- Accept it. The product page shows it as accepted, with your name. A build-ahead starts. The next issue that names it targets it.
- Reject a second repository, then push to its config again. It stays rejected.
- Change a config to name another active product. The repository leaves `factoree-test` and shows as pending in the other product.
- After the migration, `c-dash` and `anthology` show as accepted, and a FAC run targets `c-dash` as before.
