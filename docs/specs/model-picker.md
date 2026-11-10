# Model picker

Amends `docs/specs/claude-code-runner.md` (the product form and the model check). Reference: models.dev `api.json`, opencode v1.19.5 `packages/opencode/src/provider/transform.ts`, read 2026-11-09.

## What it does
The product page shows one summary row per role, for example "Claude Code · Claude Sonnet 5.5 · high". A Change button opens a dialog with a runner toggle, a searchable model list grouped by provider and an effort control that offers only the values the chosen model accepts. Each provider names the key it needs and says whether the product holds it, with an Add key button. The operator never types a model id, an effort value or a key name from memory.

## Decisions
- The API fetches `https://models.dev/api.json` with its ETag when the stored copy is older than 24 hours, and keeps the last good copy in a `model_catalog` table — the picker stays current, and a failed fetch keeps the old list.
- `GET /admin/model-catalog?runner=opencode|claude` serves a trimmed catalog: per provider its id, name and `env` names; per model its id, name, reasoning flag, effort values, context limit, input and output cost per million tokens and release date — the 6 MB file never reaches the browser, and the CSP stays `default-src 'self'`.
- The catalog hides models with `status: deprecated` — opencode's own model dialog hides them. It also hides models without `tool_call` and models whose `type` is not text — a coding agent needs tool calls.
- The effort values of a model follow opencode 1.19.5 `reasoningVariants()`: the `effort` values of `reasoning_options` in catalog order; else `high` and `max` for `budget_tokens`; else none. An empty list hides the effort control — the picker then offers exactly what `--variant` accepts.
- The claude runner lists the `anthropic` provider only. The picker stores the full `claude-*` id, and the Claude Code effort set stays `low` to `max` — an alias such as `opus` moves when Claude Code updates, and a full id runs the same model every time.
- The dialog has "Use a model id not in the list", a free-text field checked by the runner rule of `claude-code-runner.md` — a gateway or a brand-new model must still work.
- A save checks a listed model's effort against its catalog values and answers 422 with the allowed values. A model id not in the catalog keeps the runner rule only.
- Each provider row shows its first `env` name and a tick or a cross for a product runner credential of that name. Add key opens the secrets form with the name filled in and the kind `runner_credential`. A claude role accepts `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` — the operator sees the key name where the model is chosen.
- A summary row whose provider key is missing shows "needs <NAME>" with Add key. Only a claude role fails the run without a key, as now — an opencode free model needs no key.
- The worker writes the provider entry of the resolved opencode model, from the same stored catalog, to a file in the sandbox. It sets `OPENCODE_MODELS_PATH` to that file and `OPENCODE_DISABLE_MODELS_FETCH=1` — opencode then knows every model the picker offers, with no egress to models.dev.
- A typed opencode model that the stored catalog lacks, but whose provider it lists, gets an entry in that file under the typed id. The entry copies the shape of the newest usable model of the provider, names no cost, and adds the chosen effort as its one variant when the copied shape lacks it — opencode 1.19.5 refuses a model id its catalog lacks, so a model released after the last refresh still runs.
- With no catalog stored and models.dev unreachable, the dialog shows the free-text fields and says the catalog did not load — an install without egress still works.
- The dialog uses the native `<dialog>` element and a filtered list with keyboard arrows. It adds no UI dependency — the CSP refuses injected styles.
- The default row sits first. A role row with no override reads "Default" and shows what the default resolves to.

## Out
- Favourites and recent models.
- A live model list from a provider key (Anthropic `GET /v1/models`, `opencode models`).
- Provider logos.
- Failing an opencode run for a missing provider key.

## How I know it works
- `just verify` passes.
- The product page shows five role rows and a default row, each with one line and a Change button.
- In the dialog, Claude Code lists only Anthropic models, and typing "sonnet" narrows the list.
- Picking `deepseek/deepseek-flash` offers the efforts low, high and max. Picking `claude-sonnet-5-5` offers low, medium, high, xhigh and max.
- A product without `DEEPSEEK_API_KEY` shows "needs DEEPSEEK_API_KEY" on a DeepSeek row. Add key opens the secret form with that name and the runner credential kind.
- A save of `deepseek/deepseek-flash` with the effort `medium` answers 422 and names low, high and max.
- With the models.dev host blocked and an empty `model_catalog`, the dialog shows the free-text fields.
- A run with an opencode role writes the model file, and the session log shows the chosen model.
- The 390 px layout shows each row and the dialog without horizontal scroll.
