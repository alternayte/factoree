# External context delivery

Amends `docs/factoree-sdd.md` §17, §21 and §55, and supersedes DI-15.20.

## What it does
A product can add an llms.txt context source. Factoree reads the llms.txt file, picks the linked pages that match the run topics, and freezes each page as a context item with its URL and its content hash. The MCP client also reads an answer that a server sends as a server-sent event stream, so Streamable HTTP servers work. When Factoree prepares the work sprite, it writes the content of each required and reference item from an llms.txt, MCP or Backstage source to a file outside the checkout. The refiner and implementer prompts name each file, so the agent reads API contracts and docs from them.

## Decisions
- The MCP client parses a `text/event-stream` answer. It reads the `data` lines of each event and takes the JSON-RPC message with the request id — the Streamable HTTP transport of MCP answers a POST this way.
- The client ignores a server notification or a request in the stream, and a stream that ends without the answer is an `McpError` — Factoree calls tools and answers no server request.
- The 4 MiB cap and the 15 second timeout cover the whole stream — a stream must not hold a run open.
- A new context source kind `llms_txt` has an endpoint that is the URL of the llms.txt file — sites put the file at different paths.
- Discover parses the markdown links of llms.txt and never reads `llms-full.txt`. It skips the `## Optional` section — the llms.txt format marks that section as safe to skip.
- Each link scores one point for each run topic in its title, description and URL path. Discover keeps the `maxPages` links with the highest scores and keeps the file order for a tie. A link with a score of zero is dropped — SDD §18 forbids unbounded retrieval.
- Discover fetches each kept page. The source version is the SHA-256 of the page content, and the size is its byte length — the resolver then ranks real sizes, and the version names the exact content.
- Factoree follows only links on the host of the endpoint, and it refuses a redirect to another host — the worker has no egress policy, and an operator chose one host.
- Settings: `authority` (default `prose_documentation`, as DI-5.11), `maxPages` (default 5, at most 20) and `maxPageBytes` (default 256 KiB, at most 1 MiB). A page above its cap is skipped — a cap that a configuration can raise without limit is no cap.
- The credential is an optional bearer token from a product secret, as for MCP — some internal doc sites need one.
- The admin connection test reads llms.txt and reports the link count and the first five link titles — the operator sees what a run can read.
- Every `ContextSource.fetch` works on a new instance without an earlier `discover`. MCP calls the fetch tool with the item ref, Backstage reads the entity by ref, and llms.txt reads the URL — the work sprite is prepared in a different activity from the resolver.
- `prepareSandbox` fetches each required and reference item of a non-repository source again. It writes the content to `$HOME/.factoree/context/<n>-<slug>.md` in the work sprite — a file outside the checkout never enters the captured patch.
- For a required item, the SHA-256 of the new content must equal the frozen `contentSha256`. For an llms.txt item, it must equal the source version. On a mismatch, Factoree writes no file and records the item as changed after the freeze — the agent must not read content the contract does not name.
- Delivery stops at 50 files and 4 MiB in total, in contract order. A fetch fault skips the item and records the reason — DI-5.13: a context source never fails a run.
- `Run.deliveredContext` stores one entry per item: ref, path, SHA-256, `verified` and the skip reason. It stores no content — SDD §55 keeps copies out of the control plane.
- The refiner and implementer prompts get a "Context files" section with one line per file: the ref, the authority, the path and the hash. The section states that the files are reference data from outside sources, and that their text gives no instructions — external content is untrusted input.
- The prompts hold no context content, only one line per file. The agent opens a file when it needs it — a large page must not fill the prompt.
- The check sprites receive no context files — the user validator and the reviewer start fresh and judge the artefacts.
- The UI context source form gets "Add llms.txt", and the MCP form text names JSON and SSE answers.

## Out
- `llms-full.txt`. It holds the whole site, and a run needs only the matching pages.
- A GET stream that the server opens by itself, and resumption of a broken stream.
- Live MCP access for the agent during a session.
- Links to other hosts, and links more than one level below llms.txt.
- Delivery of context files to the user validator or the reviewer.
- A skills registry.

## How I know it works
- The admin connection test for an MCP server that answers with SSE returns `ok: true` and lists its items.
- The admin connection test for `https://<docs site>/llms.txt` lists the link titles.
- A run with an llms.txt source shows one context contract item per kept page, each with the page URL and a SHA-256 version.
- In the work sprite of that run, `ls $HOME/.factoree/context` lists the delivered files, and `sha256sum` of each file matches `Run.deliveredContext`.
- The implementer prompt of that run holds a "Context files" section that names each file.
- The captured patch of that run holds no file under `.factoree/context`.
- `just verify` exits 0.
