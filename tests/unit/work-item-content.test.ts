import { describe, expect, it } from "vitest";
import {
  classifyLink,
  collectImages,
  imageReferencesIn,
  keptComments,
  linkUrlsIn,
  readLinks,
  WORK_ITEM_MAX_IMAGE_BYTES,
  type LinkHosts,
  type WorkItemComment,
  type WorkItemLinkReaders,
} from "~/domain/context/work-item-content.js";
import { createLinearWorkItemReader } from "~/adapters/linear/linear-work-item-content.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const upload = (name: string) => `https://uploads.linear.app/org/${name}`;

const comment = (overrides: Partial<WorkItemComment> & { id: string }): WorkItemComment => ({
  body: "text",
  createdAt: "2026-11-10T10:00:00.000Z",
  author: "Ann",
  bot: false,
  agentSessionId: null,
  parentId: null,
  ...overrides,
});

describe("keptComments", () => {
  it("keeps human comments in time order and drops bots, agent-session threads and later comments", () => {
    const kept = keptComments(
      [
        comment({ id: "late", createdAt: "2026-11-10T12:00:00.000Z" }),
        comment({ id: "second", createdAt: "2026-11-10T10:30:00.000Z" }),
        comment({ id: "first", createdAt: "2026-11-10T09:00:00.000Z" }),
        comment({ id: "bot", bot: true }),
        comment({ id: "session-root", agentSessionId: "session-1" }),
        comment({ id: "session-reply", parentId: "session-root" }),
        comment({ id: "bot-root", bot: true, createdAt: "2026-11-10T08:00:00.000Z" }),
        comment({ id: "reply-to-bot", parentId: "bot-root" }),
        comment({ id: "reply-to-human", parentId: "first", createdAt: "2026-11-10T09:30:00.000Z" }),
        comment({ id: "empty", body: "  " }),
      ],
      "2026-11-10T11:00:00.000Z",
    );
    expect(kept.map((entry) => entry.id)).toEqual(["first", "reply-to-human", "second"]);
  });
});

describe("collectImages", () => {
  it("keeps PNG on uploads.linear.app, skips other hosts, SVG and oversize, and counts the cap on kept images only", async () => {
    const references = imageReferencesIn([
      {
        origin: "the description",
        text: [
          "The header must look like this ![mock](https://uploads.linear.app/org/a)",
          "![svg](https://uploads.linear.app/org/svg)",
          "![elsewhere](https://example.com/b.png)",
          "![big](https://uploads.linear.app/org/big)",
          ...Array.from({ length: 11 }, (_, index) => `![n](${upload(`n${index}`)})`),
        ].join("\n"),
      },
    ]);
    const { images, skipped } = await collectImages(references, (url) => {
      if (url.endsWith("/svg")) return Promise.resolve(SVG);
      if (url.endsWith("/big")) return Promise.reject(new Error(`the image is more than ${WORK_ITEM_MAX_IMAGE_BYTES} bytes`));
      return Promise.resolve(PNG);
    });

    expect(images).toHaveLength(10);
    expect(images[0]).toMatchObject({ n: 1, url: upload("a"), extension: "png", caption: "The header must look like this" });
    expect(images[9]?.url).toBe(upload("n8"));
    expect(skipped.map((image) => image.url)).toEqual([
      upload("svg"),
      "https://example.com/b.png",
      upload("big"),
      upload("n9"),
      upload("n10"),
    ]);
    expect(skipped[0]?.reason).toContain("not a PNG, JPEG, GIF or WebP");
    expect(skipped[3]?.reason).toContain("at most 10 images");
  });
});

const HOSTS: LinkHosts = {
  githubWebUrl: "https://github.com",
  repositories: [{ fullName: "alternayte/anthology", githubInstallationId: "install-1" }],
  sources: [{ sourceId: "docs", kind: "llms_txt", endpoint: "https://docs.example.dev/llms.txt", authority: "api_documentation" }],
};

describe("classifyLink", () => {
  it("follows a Linear issue, a GitHub pull request or file of the product, and a source host only", () => {
    expect(classifyLink("https://linear.app/acme/issue/FAC-100/some-title", HOSTS)).toEqual({
      kind: "follow",
      target: { kind: "linear_issue", identifier: "FAC-100" },
    });
    expect(classifyLink("https://github.com/alternayte/anthology/pull/12", HOSTS)).toMatchObject({
      kind: "follow",
      target: { kind: "github_pull", repository: "alternayte/anthology", number: 12, githubInstallationId: "install-1" },
    });
    expect(classifyLink("https://github.com/Alternayte/Anthology/blob/main/src/a.ts", HOSTS)).toMatchObject({
      kind: "follow",
      target: { kind: "github_file", repository: "alternayte/anthology", ref: "main", path: "src/a.ts" },
    });
    expect(classifyLink("https://docs.example.dev/guide.md#part", HOSTS)).toEqual({
      kind: "follow",
      target: { kind: "source", sourceId: "docs", sourceKind: "llms_txt", ref: "docs:https://docs.example.dev/guide.md", authority: "api_documentation" },
    });
  });

  it("reads no unknown host, no repository outside the product, no other scheme and no credentials in the URL", () => {
    expect(classifyLink("https://example.com/page", HOSTS)).toMatchObject({ kind: "not_read", host: "example.com" });
    expect(classifyLink("https://github.com/other/repo/issues/1", HOSTS)).toMatchObject({ kind: "not_read", host: "github.com" });
    expect(classifyLink("http://docs.example.dev/guide.md", HOSTS)).toMatchObject({ kind: "not_read" });
    expect(classifyLink("https://user:pw@docs.example.dev/guide.md", HOSTS)).toMatchObject({ kind: "not_read" });
    expect(classifyLink("https://169.254.169.254/latest/meta-data", HOSTS)).toMatchObject({ kind: "not_read" });
  });
});

describe("readLinks", () => {
  it("lists unknown hosts as not read, stops at 10 followed links, and lets a failed read use no place", async () => {
    const urls = linkUrlsIn([
      {
        origin: "the description",
        text: [
          "See https://example.com/spec. and [the PR](https://github.com/alternayte/anthology/pull/1)",
          "![shot](https://uploads.linear.app/org/x)",
          "https://linear.app/acme/issue/FAC-404",
          ...Array.from({ length: 10 }, (_, index) => `https://linear.app/acme/issue/FAC-${index + 1}`),
        ].join("\n"),
      },
    ]);
    expect(urls).not.toContain("https://uploads.linear.app/org/x");
    expect(urls[0]).toBe("https://github.com/alternayte/anthology/pull/1");
    expect(urls).toContain("https://example.com/spec");

    const readers: WorkItemLinkReaders = {
      linearIssue: (identifier) =>
        identifier === "FAC-404" ? Promise.reject(new Error("no issue")) : Promise.resolve({ title: identifier, content: `# ${identifier}` }),
      github: () => Promise.resolve({ title: "PR", content: "body" }),
      source: () => Promise.reject(new Error("unused")),
    };
    const { links, notRead } = await readLinks(urls, HOSTS, readers);

    expect(links).toHaveLength(10);
    expect(links[0]).toMatchObject({ sourceId: "linear", ref: "linear:link:https://github.com/alternayte/anthology/pull/1", authority: "prose_documentation" });
    expect(links[1]?.authority).toBe("product_documentation");
    expect(notRead.map((link) => link.host)).toEqual(["example.com", "linear.app", "linear.app"]);
    expect(notRead[1]?.reason).toContain("could not be read");
    expect(notRead[2]?.reason).toContain("at most 10 links");
  });
});

describe("createLinearWorkItemReader downloadImage", () => {
  it("refuses a redirect to another host and never sends the token there", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fake = ((url: string, init?: RequestInit) => {
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url === upload("a")) return Promise.resolve(new Response(null, { status: 302, headers: { location: upload("b") } }));
      if (url === upload("b")) return Promise.resolve(new Response(null, { status: 302, headers: { location: "http://10.0.0.1/x" } }));
      return Promise.resolve(new Response(PNG));
    }) as typeof fetch;

    await expect(createLinearWorkItemReader("token-1", fake).downloadImage(upload("a"), 1024)).rejects.toThrow(/another host/);
    expect(calls.map((call) => call.url)).toEqual([upload("a"), upload("b")]);
    expect(calls.every((call) => call.authorization === "Bearer token-1")).toBe(true);
  });

  it("stops a body over the cap", async () => {
    const fake = (() => Promise.resolve(new Response(new Uint8Array(2048)))) as typeof fetch;
    await expect(createLinearWorkItemReader("token-1", fake).downloadImage(upload("a"), 1024)).rejects.toThrow(/more than 1024/);
  });
});
