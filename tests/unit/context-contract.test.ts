import { describe, expect, it } from "vitest";
import {
  CONTEXT_CONTRACT_VERSION,
  ContextContractInvalidError,
  hashContextContract,
  renderContextContract,
  requiredContextLines,
  validateContextContract,
} from "~/domain/context/context-contract.js";
import type { ContextContract } from "~/domain/context/context-contract.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const contract = (over: Partial<ContextContract> = {}): ContextContract => ({
  version: CONTEXT_CONTRACT_VERSION,
  runId: "run-1",
  goal: "Retry webhook deliveries.",
  primaryRepository: { repo: "acme/webhook-service", sha: SHA_A },
  referenceRepositories: [
    { repo: "acme/notification-service", sha: SHA_B, reason: "provides the notification API" },
  ],
  items: [
    {
      reference: {
        sourceId: "repository",
        ref: "repository:acme/webhook-service:docs/ADR-031.md",
        repository: "acme/webhook-service",
        sha: SHA_A,
        path: "docs/ADR-031.md",
      },
      sourceVersion: SHA_A,
      authority: "accepted_adr",
      reason: "an accepted architecture decision record",
      classification: "required",
      topics: ["notification"],
      contentSha256: "c".repeat(64),
    },
  ],
  conflicts: [],
  ...over,
});

describe("validateContextContract", () => {
  it("accepts a complete contract", () => {
    expect(() => validateContextContract(contract())).not.toThrow();
  });

  it("rejects an item with no source", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    item.reference = { ...item.reference, sourceId: "" };
    expect(() => validateContextContract(broken)).toThrow(ContextContractInvalidError);
  });

  it("rejects an item with no stable reference", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    item.reference = { ...item.reference, ref: "" };
    expect(() => validateContextContract(broken)).toThrow(/reference/i);
  });

  it("rejects an item with no source version", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    item.sourceVersion = "";
    expect(() => validateContextContract(broken)).toThrow(/version/i);
  });

  it("rejects an item with an unknown authority class", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    // The cast reaches the runtime guard. The type system hides that guard.
    item.authority = "made_up" as typeof item.authority;
    expect(() => validateContextContract(broken)).toThrow(/authority/i);
  });

  it("rejects an item with no selection reason", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    item.reason = "  ";
    expect(() => validateContextContract(broken)).toThrow(/reason/i);
  });

  it("rejects an item with an unknown classification", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    item.classification = "maybe" as typeof item.classification;
    expect(() => validateContextContract(broken)).toThrow(/classification/i);
  });

  it("rejects a required item with no content hash", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    item.contentSha256 = null;
    expect(() => validateContextContract(broken)).toThrow(/content hash/i);
  });

  it("accepts a discoverable item with no content hash", () => {
    const fine = contract();
    const item = fine.items[0];
    if (item === undefined) throw new Error("fixture");
    item.classification = "discoverable";
    item.contentSha256 = null;
    expect(() => validateContextContract(fine)).not.toThrow();
  });

  it("names the offending reference in the message", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    item.reason = "";
    expect(() => validateContextContract(broken)).toThrow(/docs\/ADR-031\.md/);
  });

  it("rejects a primary repository SHA that is not forty hexadecimal characters", () => {
    expect(() =>
      validateContextContract(contract({ primaryRepository: { repo: "acme/x", sha: "main" } })),
    ).toThrow(/SHA/);
  });

  it("rejects a reference repository SHA that is not forty hexadecimal characters", () => {
    expect(() =>
      validateContextContract(
        contract({ referenceRepositories: [{ repo: "acme/y", sha: "HEAD", reason: "r" }] }),
      ),
    ).toThrow(/SHA/);
  });

  it("rejects repository content that names no repository", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    item.reference = { ...item.reference, repository: null };
    expect(() => validateContextContract(broken)).toThrow(/names no repository/);
  });

  it("rejects repository content whose commit SHA is not forty hexadecimal characters", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    item.reference = { ...item.reference, sha: "main" };
    expect(() => validateContextContract(broken)).toThrow(/explicit commit SHA/);
  });

  it("accepts an item that is not repository content and carries no repository or SHA", () => {
    const fine = contract();
    const item = fine.items[0];
    if (item === undefined) throw new Error("fixture");
    item.reference = {
      sourceId: "linear",
      ref: "linear:issue:run-1",
      repository: null,
      sha: null,
      path: null,
    };
    expect(() => validateContextContract(fine)).not.toThrow();
  });

  it("rejects two items that share a reference", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    broken.items = [item, { ...item }];
    expect(() => validateContextContract(broken)).toThrow(/twice/i);
  });
});

describe("hashContextContract", () => {
  it("returns sixty-four hexadecimal characters", () => {
    expect(hashContextContract(contract())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same hash for the same contract", () => {
    expect(hashContextContract(contract())).toBe(hashContextContract(contract()));
  });

  it("returns a different hash when any field changes", () => {
    expect(hashContextContract(contract())).not.toBe(
      hashContextContract(contract({ goal: "Something else." })),
    );
  });

  it("returns a different hash when an item field changes", () => {
    const changed = contract();
    const item = changed.items[0];
    if (item === undefined) throw new Error("fixture");
    item.classification = "reference";
    expect(hashContextContract(contract())).not.toBe(hashContextContract(changed));
  });

  it("ignores the order the object keys were built in", () => {
    const a = contract();
    const b = contract();
    b.primaryRepository = { sha: SHA_A, repo: "acme/webhook-service" };
    expect(hashContextContract(a)).toBe(hashContextContract(b));
  });

  it("ignores the key order inside a nested item", () => {
    const a = contract();
    const b = contract();
    const item = b.items[0];
    if (item === undefined) throw new Error("fixture");
    const { path, sha, repository, ref, sourceId } = item.reference;
    item.reference = { path, sha, repository, ref, sourceId };
    expect(hashContextContract(a)).toBe(hashContextContract(b));
  });
});

describe("renderContextContract", () => {
  it("names the pinned SHA of every repository", () => {
    const text = renderContextContract(contract());
    expect(text).toContain("acme/webhook-service");
    expect(text).toContain(SHA_A);
    expect(text).toContain("acme/notification-service");
    expect(text).toContain(SHA_B);
  });

  it("names the authority, the classification, and the reason of every item", () => {
    const text = renderContextContract(contract());
    expect(text).toContain("accepted_adr");
    expect(text).toContain("required");
    expect(text).toContain("an accepted architecture decision record");
  });

  it("records a resolved conflict with its winner and its loser", () => {
    const text = renderContextContract(
      contract({
        conflicts: [
          {
            id: "CTX-1",
            subject: "notification",
            winnerRef: "docs/ADR-031.md",
            loserRef: "README.md",
            reason: "accepted ADR has higher architecture authority than repository README",
            resolution: "resolved",
          },
        ],
      }),
    );
    expect(text).toContain("CTX-1");
    expect(text).toContain("docs/ADR-031.md");
    expect(text).toContain("README.md");
  });

  it("records an unresolved conflict as unresolved", () => {
    const text = renderContextContract(
      contract({
        conflicts: [
          {
            id: "CTX-1",
            subject: "notification",
            winnerRef: null,
            loserRef: null,
            reason: "two equally authoritative sources",
            resolution: "unresolved",
          },
        ],
      }),
    );
    expect(text).toContain("unresolved");
    expect(text).toContain("two equally authoritative sources");
  });
});

describe("requiredContextLines", () => {
  it("lists the required items only", () => {
    const fine = contract();
    fine.items = [
      ...fine.items,
      {
        reference: {
          sourceId: "repository",
          ref: "repository:acme/webhook-service:README.md",
          repository: "acme/webhook-service",
          sha: SHA_A,
          path: "README.md",
        },
        sourceVersion: SHA_A,
        authority: "repository_readme",
        reason: "the repository README",
        classification: "discoverable",
        topics: [],
        contentSha256: null,
      },
    ];
    const lines = requiredContextLines(fine);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("docs/ADR-031.md");
  });
});
