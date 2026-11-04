# Browser network control

Amends `docs/factoree-sdd.md` §36 and §37, and `docs/specs/proof-pack-and-visual-evidence.md`.

## What it does
A browser step in a Validation Plan can hold the HTTP requests that match a URL pattern, or make them fail. It works for any API call the page makes, REST or GraphQL or any other, because it matches the request URL and nothing else. A held request waits until a release step, so a screenshot shows a loading state every time instead of by chance. A failed request lets a plan prove an error state against the real page code. No step invents a response body, so a check still proves what the product returns.

## Decisions
- `holdRequest {url}` holds each matching request until `releaseRequests`, or until the browser scenario ends — it changes timing, never data, so a transient state becomes deterministic.
- `failRequest {url, status}` answers each matching request with that HTTP status and an empty body, or aborts it as a network error when `status` is `network` — it proves an error state with the real page code.
- No step fulfils a request with a made-up body — a stubbed backend would prove the stub, not the product.
- The steps match any HTTP request of the page by its URL, whatever the API style — a loading or error state looks the same to the browser for REST and for GraphQL.
- The `url` is a URL glob, such as `**/api/configs`, `https://api.example.com/v1/**` or `**/graphql`, and never a regular expression — a reviewer reads it at a glance.
- A step matches by URL only, never by request body — a GraphQL API sends every operation to one URL, so a GraphQL plan holds or fails all of them together, and the rule stays readable.
- The glob may name any host — these steps only delay or deny a request the page already makes, and a front end usually calls an API on another host (c-dash calls `api.atmosbot.com`).
- `goto` stays limited to preview paths — only the two network steps name other hosts.
- A held request releases itself after 30 seconds — a plan can never stall a run.
- The plan rules reject a `holdRequest` that no `expectText`, `expectVisible` or `screenshot` follows before its release — a hold that checks nothing proves nothing.
- Each step result names the requests it held or failed, by method and URL, and the browser evidence keeps them — the proof shows which call the step affected.
- The proof pack marks an assertion whose plan used `failRequest`: its error came from Factoree, not from the backend — a reviewer must know the failure was injected.
- The user validator prompt lists both steps with one example each, and says that a loading state uses `holdRequest` and an error state uses `failRequest` — the validator writes the plan, so it must know the steps exist.

## Out
- A step that fulfils, rewrites or records a response.
- Network control for HTTP and command assertions.
- WebSocket frames, and matching one GraphQL operation by its body.
- A change to the egress allow list of the sandbox or the worker.

## How I know it works
- A plan that holds a REST call of a local test page shows its loading state in the screenshot on every run.
- A plan that holds `**/graphql` on the c-dash `/configs` page shows "Loading configs..." in its screenshot on every run, and the assertion passes without UNSTABLE.
- A plan that fails an API call with status 500 reaches the page's error state, and the proof pack marks the assertion as injected.
- A plan with a `holdRequest` and no check before its release is rejected by the plan rules, and the validator gets one correction.
- A plan step that names a regular expression is rejected.
- A browser driver test pins hold, release, auto-release and fail against a local page.
- `just verify` passes.
