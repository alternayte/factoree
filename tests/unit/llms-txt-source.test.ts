import { describe, expect, it } from "vitest";
import { LlmsTxtContextSource, parseLlmsTxt, selectLlmsTxtLinks } from "~/domain/context/llms-txt-source.js";
import { DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION } from "~/domain/context/repository-context-configuration.js";

const ENDPOINT = "https://docs.test/llms.txt";

const INDEX = [
  "# Acme",
  "",
  "> Acme docs.",
  "",
  "## Docs",
  "",
  "- [Webhooks](https://docs.test/webhooks.md): Retry a failed webhook delivery",
  "- [Billing](/billing.md): Invoices and plans",
  "- [Notification retry](notifications/retry.md)",
  "- [Elsewhere](https://other.test/retry.md): retry on another host",
  "- [Everything](https://docs.test/llms-full.txt)",
  "",
  "## Optional",
  "",
  "- [Retry history](https://docs.test/retry-history.md): Old retry notes",
].join("\n");

describe("parseLlmsTxt", () => {
  it("keeps links on the endpoint host, skips the Optional section and llms-full.txt", () => {
    expect(parseLlmsTxt(INDEX, ENDPOINT)).toEqual([
      { title: "Webhooks", url: "https://docs.test/webhooks.md", description: "Retry a failed webhook delivery" },
      { title: "Billing", url: "https://docs.test/billing.md", description: "Invoices and plans" },
      { title: "Notification retry", url: "https://docs.test/notifications/retry.md", description: "" },
    ]);
  });
});

describe("selectLlmsTxtLinks", () => {
  it("ranks by the run topics found, keeps file order on a tie, drops a zero score, and caps the count", () => {
    const links = parseLlmsTxt(INDEX, ENDPOINT);
    const selected = selectLlmsTxtLinks(links, ["notification", "retry", "webhook"], 5);
    expect(selected.map((entry) => entry.link.title)).toEqual(["Webhooks", "Notification retry"]);
    expect(selectLlmsTxtLinks(links, ["retry"], 1).map((entry) => entry.link.title)).toEqual(["Webhooks"]);
  });
});

describe("LlmsTxtContextSource", () => {
  const pages: Record<string, string> = {
    [ENDPOINT]: INDEX,
    "https://docs.test/webhooks.md": "x".repeat(2000),
    "https://docs.test/notifications/retry.md": "Retry each notification three times.",
  };
  const source = new LlmsTxtContextSource({
    sourceId: "docs",
    endpoint: ENDPOINT,
    settings: { kind: "llms_txt", authority: "prose_documentation", maxPages: 5, maxPageBytes: 1000 },
    pages: {
      read: (url, maxBytes) => {
        const page = pages[url];
        if (page === undefined) return Promise.reject(new Error(`no page ${url}`));
        return Promise.resolve(Buffer.byteLength(page) > maxBytes ? null : page);
      },
    },
  });

  it("skips a page above its cap and versions a kept page by its content hash", async () => {
    const candidates = await source.discover({
      runId: "run",
      goal: "Retry",
      topics: ["notification", "retry", "webhook"],
      primaryRepository: { slug: "acme/app", url: "https://git.test/acme/app", ref: "main" },
      referenceRepositories: [],
      workItemReferences: [],
      decisions: [],
      contextConfiguration: DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION,
    });
    expect(candidates.map((candidate) => candidate.reference.ref)).toEqual([
      "docs:https://docs.test/notifications/retry.md",
    ]);
    const [candidate] = candidates;
    const document = await source.fetch(candidate!.reference);
    expect(candidate!.sourceVersion).toBe(document.sourceVersion);
    expect(candidate!.sizeBytes).toBe(Buffer.byteLength(document.content));
  });
});
