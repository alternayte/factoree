/* eslint-disable @typescript-eslint/require-await -- store doubles intentionally return immediately */
import { describe, expect, it } from "vitest";
import {
  createProofPackActivities,
  type ProofPackActivityDependencies,
  type PublishProofPackActivityInput,
} from "~/activities/evidence.activities.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { EvidenceRecord } from "~/domain/evidence/evidence.js";
import type { ReviewFindingRecord } from "~/domain/review/review-finding-store.js";
import type { ValidationAssertionResultRecord } from "~/domain/validation/validation-result-store.js";
import type { StoredValidationContract } from "~/domain/validation/validation-contract-store.js";
import type { StoredContextContract } from "~/domain/context/context-contract-store.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";

const contract: StoredValidationContract = {
  id: "vc-1",
  tenantId: "t1",
  runId: "run-1",
  version: 1,
  sha256: "b".repeat(64),
  workItem: "ENG-143",
  goal: "Add the health endpoint.",
  document: "# Validation Contract\n",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  assertions: [
    {
      rowId: "row-1",
      id: "VAL-API-001",
      requirement: "AC-1",
      statement: "GET /health returns 200.",
      method: "http",
      evidence: ["request-response"],
      preconditions: [],
    },
  ],
};

const contextContract: StoredContextContract = {
  id: "cc-1",
  tenantId: "t1",
  runId: "run-1",
  version: 1,
  sha256: "a".repeat(64),
  document: "# Context Contract\n",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  items: [
    {
      reference: {
        sourceId: "repository",
        ref: "github:acme/fixture/README.md",
        repository: "acme/fixture",
        sha: "0".repeat(40),
        path: "README.md",
      },
      sourceVersion: "0".repeat(40),
      authority: "repository_readme",
      reason: "it states the health endpoint contract",
      classification: "required",
      topics: ["health"],
      contentSha256: "c".repeat(64),
    },
    {
      reference: {
        sourceId: "repository",
        ref: "github:acme/fixture/docs/big.md",
        repository: "acme/fixture",
        sha: "0".repeat(40),
        path: "docs/big.md",
      },
      sourceVersion: "0".repeat(40),
      authority: "prose_documentation",
      reason: "it is too large to preload",
      classification: "discoverable",
      topics: ["health"],
      contentSha256: null,
    },
  ],
  conflicts: [
    {
      id: "CTX-4",
      subject: "notification ownership",
      authorityDomain: "architecture_intent",
      winnerRef: "ADR-031",
      loserRef: "README.md",
      reason: "an accepted ADR has higher architecture authority",
      resolution: "resolved",
    },
  ],
};

const results: ValidationAssertionResultRecord[] = [
  {
    id: "r1",
    tenantId: "t1",
    runId: "run-1",
    validationAssertionId: "row-1",
    assertionKey: "VAL-API-001",
    result: "FAIL",
    reason: "The endpoint answered 500.",
    attempt: 1,
    createdAt: new Date("2026-01-01T01:00:00.000Z"),
  },
  {
    id: "r2",
    tenantId: "t1",
    runId: "run-1",
    validationAssertionId: "row-1",
    assertionKey: "VAL-API-001",
    result: "PASS",
    reason: "The endpoint answered 200 with the secret sk-fixture-value-123.",
    attempt: 2,
    createdAt: new Date("2026-01-01T02:00:00.000Z"),
  },
];

const evidenceRows: EvidenceRecord[] = [
  {
    id: "e1",
    tenantId: "t1",
    runId: "run-1",
    validationAssertionId: "row-1",
    kind: "request-response",
    source: "http:VAL-API-001:request-response",
    createdAt: new Date("2026-01-01T02:00:00.000Z"),
    sha256: "d".repeat(64),
    storageRef: "file:VAL-API-001.json",
    metadata: {},
  },
  {
    id: "e2",
    tenantId: "t1",
    runId: "run-1",
    validationAssertionId: null,
    kind: "deterministic_check",
    source: "verify:unit",
    createdAt: new Date("2026-01-01T01:30:00.000Z"),
    sha256: "e".repeat(64),
    storageRef: null,
    metadata: {
      name: "unit",
      command: "npm test",
      exitCode: 0,
      passed: true,
      durationMs: 1200,
      stdoutSha256: "f".repeat(64),
      stderrSha256: "0".repeat(64),
      // The verify activity writes the retained log here. The Proof Pack must never carry it.
      log: "IMPLEMENTER TRANSCRIPT LINE",
    },
  },
];

const findings: ReviewFindingRecord[] = [
  {
    id: "f1",
    tenantId: "t1",
    runId: "run-1",
    attempt: 1,
    verdict: "fail",
    findingKey: "RV-1",
    severity: "blocker",
    category: "correctness",
    requirement: "AC-1",
    evidence: "src/health.ts:10",
    description: "The handler throws.",
    blocking: true,
    decisionReason: "a blocker finding blocks by default",
    createdAt: new Date("2026-01-01T01:40:00.000Z"),
  },
  {
    id: "f2",
    tenantId: "t1",
    runId: "run-1",
    attempt: 2,
    verdict: "pass",
    findingKey: "RV-2",
    severity: "high",
    category: "performance",
    requirement: "AC-1",
    evidence: "src/health.ts:12",
    description: "The handler reads the whole table.",
    blocking: false,
    decisionReason: "the finding names no mandatory requirement",
    createdAt: new Date("2026-01-01T02:10:00.000Z"),
  },
];

interface Harness {
  activities: ReturnType<typeof createProofPackActivities>;
  posted: string[];
  /** The proof-pack.json text of every post. */
  documents: string[];
  proofPacks: Array<{ sha256: string; postedAt: Date }>;
  order: string[];
}

const build = (
  overrides: Partial<ProofPackActivityDependencies> = {},
  options: { respondThrows?: boolean } = {},
): Harness => {
  const posted: string[] = [];
  const documents: string[] = [];
  const proofPacks: Array<{ sha256: string; postedAt: Date }> = [];
  const order: string[] = [];
  // The redactor starts empty on purpose. The secret reaches it only if the activity loads it
  // from the Project secret store, which is exactly the SDD section 60 rule under test.
  const redactor = new Redactor();
  const dependencies = {
    runs: {
      setProofPack: async (
        _tenantId: string,
        _runId: string,
        proofPack: { sha256: string; postedAt: Date },
      ) => {
        order.push("record");
        proofPacks.push(proofPack);
      },
      listRunTargets: async () => [],
    },
    products: { findById: async () => null },
    repositories: { listByProduct: async () => [] },
    contextContracts: { findByRun: async () => contextContract },
    validationContracts: { findByRun: async () => contract },
    validationResults: { listForRun: async () => results },
    evidence: { listForRun: async () => evidenceRows },
    reviewFindings: { listForRun: async () => findings },
    agentSession: {
      addLink: async () => {
        order.push("link");
      },
      respond: async (_sessionId: string, body: string) => {
        order.push("post");
        if (options.respondThrows === true) throw new Error("Linear is down");
        posted.push(body);
      },
    },
    storage: {
      name: "fake",
      put: async (artifact: { name: string; bytes: Uint8Array }) => {
        documents.push(Buffer.from(artifact.bytes).toString("utf8"));
        return { storageRef: `https://uploads.linear.app/${artifact.name}`, sha256: "f".repeat(64), byteLength: 1 };
      },
    },
    secrets: new MemorySecretStore({ API_TOKEN: "sk-fixture-value-123" }),
    redactor,
    logger: createLogger({ level: "error", redactor, sink: () => undefined }),
    ...overrides,
  } as unknown as ProofPackActivityDependencies;

  return { activities: createProofPackActivities(dependencies), posted, documents, proofPacks, order };
};

const input: PublishProofPackActivityInput = {
  runId: "run-1",
  tenantId: "t1",
  productId: "p1",
  sessionId: "session-1",
  workItem: { title: "Add the health endpoint", url: null },
  pullRequestUrl: "https://github.com/acme/fixture/pull/1",
  commitSha: "1".repeat(40),
  patchSha256: "2".repeat(64),
  baseSha: "3".repeat(40),
  changedFiles: ["src/health.ts"],
  patchByteLength: 812,
  previewUrl: null,
  repairCount: 1,
  repairLimit: 2,
  reviewVerdict: "pass",
  reviewPasses: 2,
  reviewAttempt: 2,
  autonomyLevel: "L3",
  autonomyReasons: [],
  checkDefiningFiles: [],
};

describe("publishProofPack", () => {
  it("posts one Proof Pack as the Linear final response", async () => {
    const harness = build();
    const output = await harness.activities.publishProofPack(input);
    expect(harness.posted).toHaveLength(1);
    expect(harness.posted[0]).toContain("## Factoree delivery");
    expect(output.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(output.assertionCount).toBe(1);
  });

  it("uses the last attempt of every assertion, not the first one", async () => {
    const harness = build();
    await harness.activities.publishProofPack(input);
    expect(harness.posted[0]).toContain("PASS");
    expect(harness.posted[0]).not.toContain("The endpoint answered 500.");
  });

  it("redacts a project secret that reached a persisted reason", async () => {
    const harness = build();
    await harness.activities.publishProofPack(input);
    expect(harness.posted[0]).not.toContain("sk-fixture-value-123");
    expect(harness.documents[0]).not.toContain("sk-fixture-value-123");
  });

  it("reads every deterministic check from its evidence row", async () => {
    const harness = build();
    await harness.activities.publishProofPack(input);
    expect(harness.posted[0]).toContain("- PASS unit: `npm test`");
  });

  it("never carries the retained log of a check into the Proof Pack", async () => {
    const harness = build();
    await harness.activities.publishProofPack(input);
    expect(harness.posted[0]).not.toContain("IMPLEMENTER TRANSCRIPT LINE");
    expect(harness.documents[0]).not.toContain("IMPLEMENTER TRANSCRIPT LINE");
  });

  it("reports only the non-blocking finding of the last review pass", async () => {
    const harness = build();
    const output = await harness.activities.publishProofPack(input);
    expect(output.limitationCount).toBe(1);
    expect(harness.posted[0]).toContain("RV-2");
    expect(harness.posted[0]).not.toContain("RV-1");
  });

  it("counts a discoverable context item and preloads none of it", async () => {
    const harness = build();
    await harness.activities.publishProofPack(input);
    const document = JSON.parse(harness.documents[0] ?? "{}") as { context: { discoverableItemCount: number } };
    expect(harness.documents[0]).toContain("github:acme/fixture/README.md");
    expect(document.context.discoverableItemCount).toBe(1);
    expect(harness.documents[0]).not.toContain("docs/big.md");
  });

  it("names the resolved context conflict", async () => {
    const harness = build();
    await harness.activities.publishProofPack(input);
    expect(harness.documents[0]).toContain("CTX-4");
    expect(harness.documents[0]).toContain("ADR-031");
  });

  it("records the Proof Pack hash on the Run row", async () => {
    const harness = build();
    const output = await harness.activities.publishProofPack(input);
    expect(harness.proofPacks).toHaveLength(1);
    expect(harness.proofPacks[0]?.sha256).toBe(output.sha256);
  });

  it("records the hash before it posts, so a Linear outage loses no proof", async () => {
    const harness = build({}, { respondThrows: true });
    await expect(harness.activities.publishProofPack(input)).rejects.toThrow("Linear is down");
    expect(harness.order).toEqual(["record", "link", "post"]);
  });

  it("produces one hash for one recorded state", async () => {
    const first = build();
    const second = build();
    const a = await first.activities.publishProofPack(input);
    const b = await second.activities.publishProofPack(input);
    expect(a.sha256).toBe(b.sha256);
  });

  it("reports no blocking finding when the last review pass reported none", async () => {
    // A passing review writes NO finding row, because it has no finding to write. The Proof
    // Pack must therefore not infer the last review pass from the rows that exist. A Run whose
    // attempt 1 review found a blocker and whose attempt 2 review passed holds only the
    // attempt 1 rows, and reporting those tells a human that a proved Run still has a blocker.
    const harness = build({
      reviewFindings: { listForRun: async () => [findings[0]!] },
    } as unknown as Partial<ProofPackActivityDependencies>);

    await harness.activities.publishProofPack({ ...input, reviewAttempt: 2 });

    expect(harness.posted[0]).toContain("0 blocking.");
    expect(harness.posted[0]).not.toContain("RV-1");
  });

  it("refuses to post when the Validation Contract is missing", async () => {
    const harness = build({
      validationContracts: { findByRun: async () => null },
    } as unknown as Partial<ProofPackActivityDependencies>);
    await expect(harness.activities.publishProofPack(input)).rejects.toThrow(/Validation Contract/);
    expect(harness.posted).toHaveLength(0);
  });

  it("records the routing, F3, from the Product, the RunTarget rows, and sibling_read evidence", async () => {
    const harness = build({
      products: {
        findById: async () => ({
          id: "p1",
          slug: "checkout-platform",
          name: "Checkout",
          status: "active",
          linearTeamKey: "PAY",
        }),
      },
      repositories: {
        listByProduct: async () => [
          { id: "repo-1", fullName: "acme/checkout-api" },
          { id: "repo-2", fullName: "acme/checkout-web" },
        ],
      },
      runs: {
        setProofPack: async () => undefined,
        listRunTargets: async () => [
          {
            id: "rt-1",
            tenantId: "t1",
            runId: "run-1",
            repositoryId: "repo-1",
            selectionReason: "sole member",
            baseSha: "3".repeat(40),
            patchSha256: "2".repeat(64),
            commitSha: "1".repeat(40),
            pullRequestUrl: "https://github.com/acme/checkout-api/pull/812",
          },
        ],
      },
      evidence: {
        listForRun: async () => [
          ...evidenceRows,
          {
            id: "e3",
            tenantId: "t1",
            runId: "run-1",
            validationAssertionId: null,
            kind: "sibling_read",
            source: "sibling_clone",
            createdAt: new Date("2026-01-01T01:20:00.000Z"),
            sha256: "9".repeat(64),
            storageRef: null,
            metadata: {
              fullName: "acme/checkout-events",
              commitSha: "1b7d004".padEnd(40, "0"),
              role: "implementer",
            },
          },
        ],
      },
    } as unknown as Partial<ProofPackActivityDependencies>);

    const output = await harness.activities.publishProofPack(input);

    const document = JSON.parse(harness.documents[0] ?? "{}") as { routing: Record<string, unknown> };
    expect(document.routing).toMatchObject({
      productSlug: "checkout-platform",
      linearTeamKey: "PAY",
      targets: [{ fullName: "acme/checkout-api", pullRequestUrl: "https://github.com/acme/checkout-api/pull/812" }],
      siblingsRead: [{ fullName: "acme/checkout-events" }],
    });
    expect(output.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports an assertion with no result row as BLOCKED rather than hide it", async () => {
    const harness = build({
      validationResults: { listForRun: async () => [] },
    } as unknown as Partial<ProofPackActivityDependencies>);
    await harness.activities.publishProofPack(input);
    const attention = harness.posted[0]?.slice(harness.posted[0].indexOf("### Needs your attention")) ?? "";
    expect(attention).toContain("is BLOCKED");
    expect(attention).toContain("No result row exists for this assertion.");
  });
});
