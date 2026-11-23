# Product copy

Amends SDD section 5 (products) and section 30 (secrets): a product can start as a copy of another product of the same tenant.

## What it does
An admin opens a product page and selects "Copy product". The form asks for a name, a slug and a Linear team. Factoree creates a new product with every setting, secret, host credential and context source of the source product. The new product starts pending. A later change to either product does not change the other.

## Decisions
- Copy every settings column of the product: autonomy, risk caps, allowed domains, runners, models and efforts per role, silence limit, refiner criteria limit, repair budget, run minutes, retention, concurrency, sandbox providers, app-change issue mode, skills repository, skill registry and PR reviewer — the tedious part of a new product is this set.
- Copy each product secret with its cipher text, kind and implementer flag — AES-GCM with a random IV binds no product, so the copy needs no decrypt and no secret leaves the server.
- Copy each host credential, with its position, and each context source configuration — both name their secret by name, and the copied secrets keep their names.
- The copy is new rows with new ids, and nothing links them to the source — the user wants two independent products.
- Do not copy repositories — a repository registers itself to one product through its .factoree/config.yaml.
- Do not copy runs, setups, app-change issues or the policy change log — they are the history of the source.
- The new product starts pending, the same as a new product — the admin checks the copy and activates it, so no agent runs above L0 on the new team before that.
- The form offers only Linear teams with no product — one Linear team maps to at most one product.
- The new product gets one policy change, field `copiedFrom`, with the source product id and slug — the log shows where its settings came from.
- One database transaction writes the product and all its rows — a failed copy leaves no half product.
- The API is `POST /admin/products/:id/copy` with name, slug and linearTeamKey, which Factoree resolves through Linear as product create does, in the same tenant — a copy across tenants would move secrets between Linear workspaces.

## Out
- A link, sync or template between products.
- Copying to another tenant.
- Choosing which parts to copy.
- Showing or changing secret values during the copy.

## How I know it works
- On the page of product A, "Copy product" with a free Linear team creates product B, pending.
- Product B shows the same settings, secret names, host credentials and context sources as A, and no repositories.
- A run on B at L0 gets the same secret values as A.
- A change to a setting or a secret of B leaves A unchanged, and the reverse.
- Copying with a slug or a Linear team already in use returns 409 and creates nothing.
- B's policy log shows one `copiedFrom` entry with A's slug.
