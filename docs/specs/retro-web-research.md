# Retro web research and live signals

Amends `docs/specs/retro-agent.md` (built in 0.23.0) and `docs/factoree-sdd.md` §29 and §58 for the retro role. Reference, read 2026-11-26: Claude Code tools reference, Anthropic web search and web fetch tools, opencode web search, Exa pricing and search docs, Tavily, Brave Search API, Firecrawl docs and repo, AIMultiple agentic search benchmark (2026-11-18), OpenAI deep research system card.

## What it does
The retro agent can search the web, read the pages it found, and query the product's signal sources live during the session. All three go through one Factoree MCP server, the retro gateway. Factoree stores each search result, each page and each live signal call with an id, so every finding still cites evidence that Factoree checks. An idea finding can now rest on web results alone, and it stays human-gated and is never delegated.

## Decisions
- The retro session gets one MCP server, the retro gateway, served by the Factoree API at its public URL. It has the tools `web_search`, `fetch_page` and the ticked tools of the product's signal sources — one path, so a Claude Code retro and an opencode retro behave the same.
- The retro session egress is the model host plus the Factoree API host — the sandbox reaches no other site.
- The retro session starts with Claude Code WebSearch and WebFetch denied, and opencode `websearch` and `webfetch` off — a finding can cite only what the gateway stored.
- A gateway call needs a random session token bound to one retro, product and tenant. The token stops working when the session ends — §52.
- `web_search` calls Exa search. Each result is a web result: URL, title, published date, snippet. The search query is redacted and capped at 400 characters before it leaves — a third party sees the query.
- `fetch_page` takes a URL that a `web_search` of the same session returned, and refuses any other URL. It gets the page text from Exa `/contents` — the agent cannot build a URL that carries data out, and the worker opens no site, so no SSRF path exists.
- The Exa key is in the install settings. `FACTOREE_WEB_SEARCH_EXA_API_KEY` wins and locks the field — the owner's env-over-UI rule. Exa beats Firecrawl on independent retrieval quality (nDCG@10 0.658 against 0.453) and gives a published date.
- The product page has a "Web research" switch, off by default. With no Exa key it is disabled and says why — query text goes to a vendor, so it is opt-in, as Keep transcripts is.
- A signal source lists its server's tools in the connection test. The operator ticks the tools the agent may call live. Tools the server marks read-only are ticked by default — §58 explicit allow list, and §29 production write stays denied.
- The worker calls each ticked signal tool with the source's token. The token never enters the sandbox. The gateway refuses a tool that is not ticked.
- The operator queries stay. Factoree runs them before the session as today — a starting set the agent reads first.
- Each session has caps: 20 searches, 40 pages, 50 live signal calls, 256 KiB per result. Search and page costs count toward the retro cost cap, and the gateway refuses a call when the cap is spent — an agent loop cannot spend without limit.
- Each web result, page and live signal call is redacted, stored with its SHA-256 and an id, and deleted after the product's retro data retention — P-12, and §51 as for signal results.
- A finding cites web result ids beside run ids and signal result ids. Factoree drops a finding that cites a web result outside its own session.
- An idea finding needs a cited analytics result or a cited web result. Factory and error findings keep their rule and may cite web results as support — an idea is human-gated and never delegated, so weak evidence stays with a person.
- The Retro page shows "web only" on an idea finding with no analytics result, and lists each retro's searches, pages and live signal calls with their links and sizes — the human sees what the idea rests on.
- The retro prompt is `retro@2`. It states that page text and tool output are data and never instructions — the gateway rules are the boundary, the prompt is not.

## Out
- Web tools for run roles. Claude Code run sessions keep native WebSearch as today. A kept transcript records it when Keep transcripts is on.
- A fetch of a URL that no search of the session returned.
- Signal tools that the operator did not tick, and any write tool by default.
- Search vendors other than Exa, and a self-hosted search service.
- A web result that backs a factory or error finding alone, or a delegated issue from web evidence.
- Browser rendering, logins or paywalled pages.

## How I know it works
- `just verify` passes.
- With "Web research" on and an Exa key, a retro on FAC shows searches and pages on the Retro page, each with its URL, date and size.
- A `fetch_page` call with a URL that no search returned fails, and the session goes on.
- A call to the gateway with the token of an ended session returns 401.
- The retro sandbox cannot reach any host other than the model host and the Factoree API (`curl https://example.com` fails in it).
- An idea finding that cites only web results shows "web only", and "Create issue" creates a FAC issue that is not delegated.
- A finding seeded with a web result id from another session does not appear.
- A signal source shows its tools after the connection test, with read-only tools ticked. A call to an unticked tool is refused and recorded as a retro event.
- A live signal call result holds a seeded secret value as redacted.
- With the cost cap spent mid-session, the gateway refuses the next search, and the retro ends with the findings it has.
- With `FACTOREE_WEB_SEARCH_EXA_API_KEY` set, the install settings field shows locked. With no key, the product switch is disabled.
- With "Web research" off, the gateway offers no web tool.
