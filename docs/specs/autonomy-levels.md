# Autonomy levels

Amends `docs/factoree-sdd.md` §27, §28, §47 and §59.

## What it does
The autonomy level of a run decides where the run stops and what it publishes. L0 stops after the context contract and posts a report. L1 stops after the checks pass and posts the evidence with no pull request. L2 runs every check and opens a draft pull request. L3 runs every check and opens a pull request that is ready for review. Only an operator can raise the level of a product.

## Decisions
- L2 runs every check that L3 runs. Only the draft flag differs — a risk cap must reduce what Factoree publishes, not how much it checks. This replaces "independent review is optional" in §27.
- The workflow reads the level once, after refinement, and branches on it — one decision point, so a later stage cannot widen it.
- Each level stops earlier on the L3 path. No level adds a stage — a lower level is always the safe direction.
- A pending product runs at L0 — it can investigate and report, nothing more.
- An L0 run in a product with no runner credential reports the context contract without the refiner — a pending product has no secrets.
- `PUT /admin/products/:id` accepts `defaultAutonomy` (L0 to L3) and `riskCaps`, a map from a Linear label to the highest level that label allows. It refuses L4 — §27 reserves it.
- A new product gets the §28 label list, each label capped at L2 — the default stays safe.
- Each policy change writes a product policy history row with the old value, the new value and the time — raising trust needs an audit trail.
- The Linear labels factoree:l0, factoree:l1 and factoree:l2 lower the level of one ticket. No label raises it — whoever can edit labels cannot remove a safety cap.
- A failed label read runs the ticket at L2, not at the product default — the read fault must fail closed.
- A run keeps the level it started with — a policy change applies to the next run.
- The proof pack states the level and the reason for each cap — a human sees why a pull request is a draft.
- The risk cap message in Linear states the real effect — today it claims a cap that nothing applies.

## Out
- Automatic promotion from a track record. Factoree does not see merges or reverts.
- L4 and any merge.
- A per-repository level. The product owns policy.

## How I know it works
- An operator raises a product:
  ```
  curl -sS -X PUT -H "Authorization: Bearer $ADMIN_API_TOKEN" -H "content-type: application/json" \
    "$API/admin/products/$PRODUCT_ID?linearWorkspaceId=$WORKSPACE" \
    -d '{"defaultAutonomy":"L3","riskCaps":{"payments":"L2","database-migration":"L3"}}'
  ```
  The response holds the new policy. `GET /admin/products/:id` shows it, and the policy history holds one new row.
- The same call with `"defaultAutonomy":"L4"` answers 422 and changes nothing.
- A ticket labelled payments in that product opens a draft pull request after verification, user validation and review all pass. The proof pack names the cap.
- A ticket labelled database-migration in that product opens a pull request that is ready for review.
- A ticket labelled factoree:l0 posts a context report, and no sandbox runs an implementer.
- A ticket labelled factoree:l1 posts the evidence and opens no pull request.
- A ticket on a pending product posts a report and opens no pull request.
- A run that started at L3 stays L3 after an operator lowers the product to L2 during the run.
