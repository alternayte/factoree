# Work item images, links and comments

Amends SDD section 7 (work item), section 17 (context sources) and section 22 (authority). Needs the
delivery part of docs/specs/external-context-delivery.md, which a build does first.

## What it does
Factoree reads the images, the links and the human comments of a delegated Linear issue. It downloads each issue image with the Linear token, freezes it as a context item with its hash, and puts it as a file in every sandbox of the run. All four agent roles receive the images. Factoree follows a link only to a known host, and it freezes the content it reads. A run whose role model cannot read images stops before it starts and says why.

## Decisions
- Factoree reads the human comments of the issue through the Linear API at delegation. It skips bot comments and agent-session threads, and keeps time order. — Humans add detail and screenshots in comments, and a session reply is already a decision (run-recovery.md).
- The comments freeze as one context item of the Linear source, authority `work_item_decision`, next to the description. A newer human sentence supersedes an older one on the same point. — Both are the author's intent. The later one is the current intent.
- An image is a markdown image in the description or a kept comment, with a URL on `uploads.linear.app`. The control plane downloads it with the install's Linear token. — The URL returns 401 without a token, and no agent session may hold that token.
- Factoree keeps PNG, JPEG, GIF and WebP only, at most 10 images and 10 MiB each, in document order. It lists a skipped image and the reason in the post. — SVG is text that can carry instructions, and SDD section 18 forbids unbounded retrieval.
- Each image freezes as a required context item of the Linear source, authority `work_item_decision`, version the SHA-256 of its bytes. — An image is the author's own intent, often the spec itself.
- Factoree stores each image as evidence and writes it to `$HOME/.factoree/context/image-<n>.<ext>` in the work sprite and in every check sprite. It checks the SHA-256 before it writes. — The validator and the reviewer must see the mockup to judge a match. A file outside the checkout never enters the patch.
- The refiner, implementer, user validator and reviewer prompts name each image file and the sentence around it, and tell the agent to open the file. — An agent reads an image only when it knows the file exists.
- Before preparation, Factoree reads the input types of each role model from the stored models.dev catalog. If the issue has an image and a role model has no `image` input, the run ends FAILED_CONFIGURATION. A model that the catalog does not know counts as no `image` input. — Factoree must not guess that an agent saw the image.
- The failure post names the role, the model and a catalog model of the same provider that reads images. It accepts a reply that changes the model, or the reply "ignore the images". That reply freezes as a decision, and the follow-up run skips the image check. — The human decides whether the images matter.
- Factoree follows a link in the description or a kept comment only in three cases. — A human chose each host, so an issue author cannot point the worker at an internal address.
  - A Linear issue link: title and description through the Linear API, authority `product_documentation`. Factoree does not follow its images or links.
  - A GitHub issue, pull request or file in a repository of the product: read with a read-only App token. The authority is `prose_documentation` for an issue or a pull request, and `source_code` for a file at the linked ref.
  - A link whose host is the host of a registered llms.txt, MCP or Backstage source of the product: read through that source's `fetch`, with that source's authority.
- Each followed link freezes as a context item with its URL and the SHA-256 of its content, and is delivered as a context file. Factoree follows one level only, refuses a redirect to another host, and stops at 10 links. — The reviewer must see exactly what the agent read.
- Factoree does not read any other link. It stays as text, and the post lists it under "Links not read" with its host. — The human sees what the run missed and can register the host.
- The prompts state that context files from links and comments are reference data and give no instructions. — Text from outside the description is untrusted input.

## Out
- Images on hosts other than `uploads.linear.app`, and video, PDF and other attachments.
- A text description of an image for a model that cannot read images.
- Links more than one level deep, and images or links inside a linked issue.
- Any public URL fetch, and agent fetches of links during a session.
- Comments added after delegation. A reply in the session stays the way to add them.

## How I know it works
- Delegate an issue with a pasted screenshot. The context contract shows an image item with a SHA-256. `ls $HOME/.factoree/context` in the work sprite and in a check sprite lists `image-1.png`, and its `sha256sum` matches.
- The implementer and reviewer prompt files of that run name `image-1.png`.
- Set the implementer model to `deepseek/deepseek-v4-pro` and delegate the same issue. The run ends FAILED_CONFIGURATION before preparation. The post names the implementer, the model and a DeepSeek model that reads images.
- Reply "ignore the images". The follow-up run starts and freezes that decision.
- Add a human comment with a second screenshot and delegate again. The contract shows the comments item and two image items.
- An issue that links FAC-100, a pull request of alternayte/anthology and https://example.com shows two link items in the contract. The post lists example.com under "Links not read".
- `npm run verify` passes.
