import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SelectedContextItem } from "~/domain/context/conflicts.js";
import {
  CONTEXT_DELIVERY_MAX_BYTES,
  CONTEXT_DELIVERY_MAX_FILES,
  deliverableItems,
  deliverContext,
  deliverImages,
} from "~/domain/context/context-delivery.js";
import type { ContextSourceKind } from "~/domain/context/context-source-configuration.js";
import { ContextSourceRegistry } from "~/domain/context/context-source-registry.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const item = (
  sourceId: string,
  name: string,
  classification: SelectedContextItem["classification"],
  hashes: { sourceVersion?: string; contentSha256?: string | null } = {},
): SelectedContextItem => ({
  reference: { sourceId, ref: `${sourceId}:${name}`, repository: null, sha: null, path: null },
  sourceVersion: hashes.sourceVersion ?? "v1",
  authority: "prose_documentation",
  reason: "a reason",
  classification,
  topics: [],
  contentSha256: hashes.contentSha256 ?? null,
});

/** One source per id. Its content is the ref's name part, or what `contents` gives. */
const registryOf = (ids: string[], contents: Record<string, string> = {}) =>
  new ContextSourceRegistry(
    ids.map((id) => ({
      id: () => id,
      discover: () => Promise.resolve([]),
      fetch: (reference) =>
        reference.ref in contents
          ? Promise.resolve({ reference, sourceVersion: "now", content: contents[reference.ref] ?? "" })
          : Promise.reject(new Error("source down")),
    })),
  );

const run = async (items: SelectedContextItem[], contents: Record<string, string>, kinds: Record<string, ContextSourceKind>) => {
  const written: Record<string, string> = {};
  const delivery = await deliverContext({
    items,
    sources: registryOf(Object.keys(kinds), contents),
    kinds: new Map(Object.entries(kinds)),
    directory: "/home/agent/.factoree/context",
    write: (path, content) => {
      written[path] = content;
      return Promise.resolve();
    },
  });
  return { delivery, written };
};

describe("deliverContext", () => {
  it("writes no file for content that changed after the freeze, and verifies a match", async () => {
    const items = [
      item("docs", "a", "required", { contentSha256: sha("frozen") }),
      item("pages", "b", "reference", { sourceVersion: sha("page") }),
      item("mcp", "c", "reference"),
      item("linear", "d", "required", { contentSha256: sha("x") }),
    ];
    const { delivery, written } = await run(
      items,
      { "docs:a": "changed", "pages:b": "page", "mcp:c": "notes" },
      { docs: "mcp", pages: "llms_txt", mcp: "mcp" },
    );
    expect(delivery.entries[0]?.skipReason).toMatch(/changed after the freeze/);
    expect(delivery.entries.slice(1)).toEqual([
      { ref: "pages:b", path: "/home/agent/.factoree/context/02-pages-b.md", sha256: sha("page"), verified: true, skipReason: null },
      { ref: "mcp:c", path: "/home/agent/.factoree/context/03-mcp-c.md", sha256: sha("notes"), verified: false, skipReason: null },
    ]);
    expect(Object.keys(written)).toEqual(["/home/agent/.factoree/context/02-pages-b.md", "/home/agent/.factoree/context/03-mcp-c.md"]);
    expect(delivery.lines).toHaveLength(2);
  });

  it("records a fetch fault and goes on", async () => {
    const { delivery } = await run([item("docs", "a", "reference"), item("docs", "b", "reference")], { "docs:b": "ok" }, { docs: "mcp" });
    expect(delivery.entries.map((entry) => entry.skipReason)).toEqual([expect.stringMatching(/source down/), null]);
  });

  it("stops at the file cap and at the byte cap, in contract order", async () => {
    const many = Array.from({ length: CONTEXT_DELIVERY_MAX_FILES + 2 }, (_, index) => item("docs", `p${index}`, "reference"));
    const contents = Object.fromEntries(many.map((entry) => [entry.reference.ref, "x"]));
    const files = await run(many, contents, { docs: "mcp" });
    expect(files.delivery.lines).toHaveLength(CONTEXT_DELIVERY_MAX_FILES);
    expect(files.delivery.entries.slice(-2).map((entry) => entry.skipReason)).toEqual([
      expect.stringMatching(/50 files/),
      expect.stringMatching(/50 files/),
    ]);

    const half = "y".repeat(CONTEXT_DELIVERY_MAX_BYTES / 2 + 1);
    const bytes = await run(
      [item("docs", "a", "reference"), item("docs", "b", "reference"), item("docs", "c", "reference")],
      { "docs:a": half, "docs:b": half, "docs:c": "small" },
      { docs: "mcp" },
    );
    expect(bytes.delivery.entries.map((entry) => entry.path === null)).toEqual([false, true, true]);
  });
});

describe("work item delivery", () => {
  it("delivers the comments and a followed link of the Linear source, and no other Linear item", () => {
    const linear = (ref: string): SelectedContextItem => ({ ...item("linear", "x", "required", { contentSha256: "h" }), reference: { sourceId: "linear", ref, repository: null, sha: null, path: null } });
    const refs = deliverableItems([
      linear("linear:issue:run-1"),
      linear("linear:comments"),
      linear("linear:link:https://linear.app/acme/issue/FAC-1"),
      linear("linear:image:1"),
    ]).map((entry) => entry.reference.ref);
    expect(refs).toEqual(["linear:comments", "linear:link:https://linear.app/acme/issue/FAC-1"]);
  });

  it("writes no image whose bytes differ from the frozen hash, and no image the sandbox wrote differently", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const frozen = createHash("sha256").update(bytes).digest("hex");
    const image = (n: number) => ({ n, url: `https://uploads.linear.app/o/${n}`, sha256: frozen, contentType: "image/png", extension: "png", byteLength: 3, caption: "the header", origin: "the description" });
    const written: string[] = [];
    const delivery = await deliverImages({
      images: [image(1), image(2), image(3)],
      directory: "/home/agent/.factoree/context",
      download: (entry) => Promise.resolve(entry.n === 2 ? new Uint8Array([9]) : bytes),
      write: (path) => {
        written.push(path);
        return Promise.resolve(path.endsWith("image-3.png") ? "0".repeat(64) : frozen);
      },
    });
    expect(written).toEqual(["/home/agent/.factoree/context/image-1.png", "/home/agent/.factoree/context/image-3.png"]);
    expect(delivery.lines).toEqual([`image-1.png — file /home/agent/.factoree/context/image-1.png, sha256 ${frozen}. From the description: "the header"`]);
    expect(delivery.entries.map((entry) => entry.skipReason === null)).toEqual([true, false, false]);
  });
});
