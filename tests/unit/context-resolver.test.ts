import { describe, expect, it } from "vitest";
import { ContextResolver } from "~/domain/context/context-resolver.js";
import { ContextSourceRegistry } from "~/domain/context/context-source-registry.js";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import { RepositoryContextSource } from "~/domain/context/repository-source.js";
import {
  CONTEXT_REQUIRED_MAX_BYTES,
  CONTEXT_REQUIRED_MAX_ITEMS,
} from "~/domain/context/context-contract.js";
import { FakeRepositoryReader } from "../support/fake-repository-reader.js";
import type { ResolveContextInput } from "~/domain/context/context-resolver.js";

const PRIMARY_URL = "https://git/acme/webhook-service";
const REFERENCE_URL = "https://git/acme/notification-service";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const primaryFiles = {
  "README.md": "# Webhook service\n\nThe README says notification retry is owned here.\n",
  "docs/ADR-031.md": "# ADR 31\n\nStatus: accepted\n\nNotification retry is owned elsewhere.\n",
  "src/retry.ts": "export const retry = () => undefined;\n",
  "tests/retry.test.ts": "it('retries', () => undefined);\n",
};

const build = (
  over: {
    primary?: Record<string, string>;
    reference?: Record<string, string>;
  } = {},
) => {
  const reader = new FakeRepositoryReader({
    [PRIMARY_URL]: { sha: SHA_A, files: over.primary ?? primaryFiles },
    [REFERENCE_URL]: { sha: SHA_B, files: over.reference ?? { "openapi.yaml": "openapi: 3.1.0\n" } },
  });
  const registry = new ContextSourceRegistry([
    new LinearContextSource(),
    new RepositoryContextSource({ reader }),
  ]);
  return new ContextResolver({ sources: registry });
};

const input = (over: Partial<ResolveContextInput> = {}): ResolveContextInput => ({
  runId: "run-1",
  goal: "Retry a failed notification delivery.",
  acceptanceCriteria: ["A failed notification is retried."],
  primaryRepository: { slug: "acme/webhook-service", url: PRIMARY_URL, ref: "main" },
  referenceRepositories: [{ slug: "acme/notification-service", url: REFERENCE_URL, ref: "main" }],
  workItemReferences: [],
  decisions: [],
  ...over,
});

describe("ContextResolver", () => {
  it("pins the primary repository and every reference repository to an explicit SHA", async () => {
    const resolved = await build().resolve(input());
    expect(resolved.pinned.primary).toEqual({ slug: "acme/webhook-service", sha: SHA_A });
    expect(resolved.pinned.references).toEqual([{ slug: "acme/notification-service", sha: SHA_B }]);
    expect(resolved.contract.primaryRepository.sha).toBe(SHA_A);
    expect(resolved.contract.referenceRepositories[0]?.sha).toBe(SHA_B);
  });

  it("produces a valid contract with a hash and a rendered document", async () => {
    const resolved = await build().resolve(input());
    expect(resolved.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(resolved.document).toContain("# Context Contract");
    expect(resolved.contract.version).toBe(1);
    expect(resolved.contract.runId).toBe("run-1");
  });

  it("gives every item complete provenance", async () => {
    const resolved = await build().resolve(input());
    expect(resolved.contract.items.length).toBeGreaterThan(0);
    for (const item of resolved.contract.items) {
      expect(item.reference.sourceId).not.toBe("");
      expect(item.reference.ref).not.toBe("");
      expect(item.sourceVersion).not.toBe("");
      expect(item.authority).not.toBe("");
      expect(item.reason).not.toBe("");
      expect(["required", "reference", "discoverable"]).toContain(item.classification);
    }
  });

  it("hashes the content of every required item", async () => {
    const resolved = await build().resolve(input());
    const required = resolved.contract.items.filter((item) => item.classification === "required");
    expect(required.length).toBeGreaterThan(0);
    for (const item of required) expect(item.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never preloads a repository itself", async () => {
    const resolved = await build().resolve(input());
    for (const slug of ["acme/webhook-service", "acme/notification-service"]) {
      const repository = resolved.contract.items.find(
        (item) => item.reference.ref === `repository:${slug}`,
      );
      expect(repository?.classification).toBe("discoverable");
      expect(repository?.contentSha256).toBeNull();
    }
  });

  it("finds an existing implementation pattern in the primary repository", async () => {
    const resolved = await build().resolve(input());
    const refs = resolved.contract.items.map((item) => item.reference.ref);
    expect(refs).toContain("repository:acme/webhook-service:src/retry.ts");
  });

  it("records the accepted ADR as the winner over the README", async () => {
    const resolved = await build().resolve(input());
    const conflict = resolved.contract.conflicts.find(
      (candidate) =>
        candidate.winnerRef === "repository:acme/webhook-service:docs/ADR-031.md" &&
        candidate.loserRef === "repository:acme/webhook-service:README.md",
    );
    expect(conflict?.resolution).toBe("resolved");
    expect(resolved.unresolvedConflict).toBeNull();
  });

  it("reports an unresolved conflict between two accepted ADRs", async () => {
    const resolved = await build({
      primary: {
        "docs/ADR-031.md": "Status: accepted. Notification retry lives here.\n",
        "docs/ADR-042.md": "Status: accepted. Notification retry lives elsewhere.\n",
      },
    }).resolve(input());
    expect(resolved.unresolvedConflict?.resolution).toBe("unresolved");
    expect(resolved.unresolvedConflict?.subject).toBe("notification");
  });

  it("keeps a human decision as a required product intent item", async () => {
    const resolved = await build().resolve(
      input({ decisions: [{ questionId: "Q-1", question: "Retry a 4xx?", answer: "No." }] }),
    );
    const decision = resolved.contract.items.find(
      (item) => item.reference.ref === "linear:decision:Q-1",
    );
    expect(decision?.classification).toBe("required");
    expect(decision?.authority).toBe("work_item_decision");
    expect(decision?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("demotes an item beyond the required item budget to discoverable", async () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < CONTEXT_REQUIRED_MAX_ITEMS + 10; index += 1) {
      many[`docs/ADR-${String(index).padStart(3, "0")}.md`] = `notification retry ${index}\n`;
    }
    const resolved = await build({ primary: many }).resolve(input());
    const required = resolved.contract.items.filter((item) => item.classification === "required");
    const discoverable = resolved.contract.items.filter(
      (item) => item.classification === "discoverable",
    );
    expect(required.length).toBe(CONTEXT_REQUIRED_MAX_ITEMS);
    expect(discoverable.length).toBeGreaterThan(0);
  });

  it("never promotes a single item that alone exceeds the required byte budget", async () => {
    const large = "notification ".repeat(CONTEXT_REQUIRED_MAX_BYTES / 4);
    const resolved = await build({
      primary: { "docs/ADR-031.md": large, "docs/ADR-042.md": large, "README.md": large },
    }).resolve(input());
    for (const path of ["docs/ADR-031.md", "docs/ADR-042.md", "README.md"]) {
      const item = resolved.contract.items.find(
        (candidate) => candidate.reference.path === path,
      );
      expect(item?.classification).toBe("discoverable");
    }
  });

  it("stops promotion once the required byte budget is spent", async () => {
    const half = "notification ".repeat(2400);
    const resolved = await build({
      primary: {
        "docs/ADR-031.md": half,
        "docs/ADR-042.md": half,
        "docs/ADR-053.md": half,
      },
    }).resolve(input());
    const promoted = ["docs/ADR-031.md", "docs/ADR-042.md", "docs/ADR-053.md"].filter((path) =>
      resolved.contract.items.some(
        (item) => item.reference.path === path && item.classification === "required",
      ),
    );
    expect(promoted).toHaveLength(2);
  });

  it("demotes an item whose content cannot be read and records why", async () => {
    const reader = new FakeRepositoryReader({
      [PRIMARY_URL]: { sha: SHA_A, files: primaryFiles },
      [REFERENCE_URL]: { sha: SHA_B, files: {} },
    });
    // The tree lists the path, and the blob read then fails. A real repository can produce that
    // race between `ls-tree` and `cat-file`.
    const original = reader.readBlob.bind(reader);
    reader.readBlob = (url, sha, path) =>
      path === "docs/ADR-031.md" ? Promise.resolve(null) : original(url, sha, path);
    const registry = new ContextSourceRegistry([
      new LinearContextSource(),
      new RepositoryContextSource({ reader }),
    ]);
    const resolved = await new ContextResolver({ sources: registry }).resolve(input());
    const item = resolved.contract.items.find(
      (candidate) => candidate.reference.ref === "repository:acme/webhook-service:docs/ADR-031.md",
    );
    expect(item?.classification).toBe("discoverable");
    expect(item?.reason).toMatch(/could not be read/);
  });

  it("ranks a higher priority rule first", async () => {
    const resolved = await build().resolve(input());
    const first = resolved.contract.items[0];
    expect(first?.reference.ref).toBe("linear:issue:run-1");
  });

  it("returns a deterministic contract for the same input", async () => {
    const one = await build().resolve(input());
    const two = await build().resolve(input());
    expect(one.sha256).toBe(two.sha256);
    expect(one.contract.items.map((item) => item.reference.ref)).toEqual(
      two.contract.items.map((item) => item.reference.ref),
    );
    expect(one.contract.conflicts.map((conflict) => conflict.id)).toEqual(
      two.contract.conflicts.map((conflict) => conflict.id),
    );
  });
});

describe("ContextResolver topic enrichment", () => {
  it("adds a topic that only the fetched content holds", async () => {
    const resolved = await build({
      primary: { "docs/ADR-031.md": "Status: accepted. Notification retry lives here.\n" },
    }).resolve(input());
    const item = resolved.contract.items.find(
      (candidate) => candidate.reference.path === "docs/ADR-031.md",
    );
    expect(item?.classification).toBe("required");
    expect(item?.topics).toContain("notification");
    expect(item?.topics).toContain("retry");
  });

  it("keeps the topics sorted and free of a duplicate", async () => {
    const resolved = await build({
      primary: { "docs/notification-ADR-031.md": "Notification retry lives here.\n" },
    }).resolve(input());
    const item = resolved.contract.items.find(
      (candidate) => candidate.reference.path === "docs/notification-ADR-031.md",
    );
    expect(item?.topics).toEqual([...new Set(item?.topics)].sort());
  });

  it("leaves the path topics of an item it never fetched", async () => {
    const large = `notification ${"delivery retried ".repeat(CONTEXT_REQUIRED_MAX_BYTES / 4)}`;
    const resolved = await build({ primary: { "docs/ADR-031-notification.md": large } }).resolve(
      input(),
    );
    const item = resolved.contract.items.find(
      (candidate) => candidate.reference.path === "docs/ADR-031-notification.md",
    );
    expect(item?.classification).toBe("discoverable");
    expect(item?.topics).toEqual(["notification"]);
  });
});
