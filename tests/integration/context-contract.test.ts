import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaContextContractStore } from "~/persistence/prisma/context-contract.prisma.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { CONTEXT_CONTRACT_VERSION } from "~/domain/context/context-contract.js";
import type { ContextContract } from "~/domain/context/context-contract.js";
import { validateContextContract } from "~/domain/context/context-contract.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { startDatabase, seedTenantProjectAndRun } from "./support/database.js";

const SHA_A = "a".repeat(40);
const CONTENT_SHA = "c".repeat(64);
const FIRST_SHA256 = "d".repeat(64);
const ADR_REF = "repository:acme/webhook-service:docs/ADR-031.md";
const README_REF = "repository:acme/webhook-service:README.md";

let database: { url: string; stop: () => Promise<void> };
let prisma: FactoreePrismaClient;
let store: PrismaContextContractStore;
let runs: PrismaRunRepository;
let tenantId = "";
let runId = "";
let otherTenantId = "";
let otherRunId = "";

const contract = (): ContextContract => ({
  version: CONTEXT_CONTRACT_VERSION,
  runId,
  goal: "Retry a failed notification delivery.",
  primaryRepository: { repo: "acme/webhook-service", sha: SHA_A },
  referenceRepositories: [],
  items: [
    {
      reference: {
        sourceId: "repository",
        ref: ADR_REF,
        repository: "acme/webhook-service",
        sha: SHA_A,
        path: "docs/ADR-031.md",
      },
      sourceVersion: SHA_A,
      authority: "accepted_adr",
      reason: "an accepted architecture decision record",
      classification: "required",
      topics: ["notification"],
      contentSha256: CONTENT_SHA,
    },
    {
      // An item that is not repository content. It records an empty topic list and no content
      // hash, so the round trip must keep both.
      reference: {
        sourceId: "work_item",
        ref: "work_item:ENG-42",
        repository: null,
        sha: null,
        path: null,
      },
      sourceVersion: "2026-08-23T10:00:00.000Z",
      authority: "work_item_decision",
      reason: "the Work Item states the goal",
      classification: "reference",
      topics: [],
      contentSha256: null,
    },
  ],
  conflicts: [
    {
      id: "CTX-1",
      subject: "notification",
      winnerRef: ADR_REF,
      loserRef: README_REF,
      reason: "accepted ADR has higher architecture authority than repository README",
      resolution: "resolved",
    },
    {
      // An unresolved conflict names no winner and no loser. SDD section 23.
      id: "CTX-2",
      subject: "delivery",
      winnerRef: null,
      loserRef: null,
      reason: "two equally authoritative sources describe delivery",
      resolution: "unresolved",
    },
  ],
});

beforeAll(async () => {
  database = await startDatabase();
  prisma = createPrismaClient(database.url);
  store = new PrismaContextContractStore(prisma);
  runs = new PrismaRunRepository(prisma);
  const seeded = await seedTenantProjectAndRun(prisma);
  tenantId = seeded.tenantId;
  runId = seeded.runId;
  const other = await seedTenantProjectAndRun(prisma);
  otherTenantId = other.tenantId;
  otherRunId = other.runId;
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
  await database.stop();
});

describe("PrismaContextContractStore", () => {
  it("stores the contract, its items, and its conflicts", async () => {
    const value = contract();
    validateContextContract(value);
    const stored = await store.save({
      tenantId,
      runId,
      contract: value,
      sha256: FIRST_SHA256,
      document: "# Context Contract\n",
    });
    expect(stored.version).toBe(1);
    expect(stored.sha256).toBe(FIRST_SHA256);
    expect(stored.items).toHaveLength(2);
    expect(stored.conflicts).toHaveLength(2);
  });

  it("reads every item back unchanged", async () => {
    const found = await store.findByRun(tenantId, runId);
    const byRef = new Map(found?.items.map((item) => [item.reference.ref, item]));
    expect(byRef.get(ADR_REF)).toEqual(contract().items[0]);
    expect(byRef.get("work_item:ENG-42")).toEqual(contract().items[1]);
  });

  it("reads every conflict back unchanged", async () => {
    const found = await store.findByRun(tenantId, runId);
    const byId = new Map(found?.conflicts.map((conflict) => [conflict.id, conflict]));
    expect(byId.get("CTX-1")).toEqual(contract().conflicts[0]);
    expect(byId.get("CTX-2")).toEqual(contract().conflicts[1]);
  });

  it("keeps the document and the identity fields", async () => {
    const found = await store.findByRun(tenantId, runId);
    expect(found?.tenantId).toBe(tenantId);
    expect(found?.runId).toBe(runId);
    expect(found?.document).toBe("# Context Contract\n");
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  it("is immutable, because a second save writes nothing and returns the stored contract", async () => {
    const again = await store.save({
      tenantId,
      runId,
      contract: { ...contract(), goal: "A different goal." },
      sha256: "e".repeat(64),
      document: "# Different\n",
    });
    expect(again.sha256).toBe(FIRST_SHA256);
    expect(again.document).toBe("# Context Contract\n");
    expect(await prisma.contextContract.count({ where: { runId } })).toBe(1);
  });

  it("writes one row only, when two concurrent saves race", async () => {
    const input = {
      tenantId: otherTenantId,
      runId: otherRunId,
      contract: { ...contract(), runId: otherRunId },
      document: "# Race\n",
    };
    const [first, second] = await Promise.all([
      store.save({ ...input, sha256: "1".repeat(64) }),
      store.save({ ...input, sha256: "2".repeat(64) }),
    ]);
    expect(second.id).toBe(first.id);
    expect(await prisma.contextContract.count({ where: { runId: otherRunId } })).toBe(1);
  });

  it("hides the contract from another tenant", async () => {
    await expect(store.findByRun(otherTenantId, runId)).resolves.toBeNull();
  });

  it("returns null for a Run with no contract", async () => {
    await expect(
      store.findByRun(tenantId, "00000000-0000-0000-0000-000000000000"),
    ).resolves.toBeNull();
  });

  it("rejects a column that holds an unknown authority class", async () => {
    await prisma.contextItem.updateMany({
      where: { ref: ADR_REF },
      data: { authority: "gossip" },
    });
    await expect(store.findByRun(tenantId, runId)).rejects.toThrow(/unknown authority class/);
    await prisma.contextItem.updateMany({
      where: { ref: ADR_REF },
      data: { authority: "accepted_adr" },
    });
  });

  it("rejects a column that holds an unknown classification", async () => {
    await prisma.contextItem.updateMany({
      where: { ref: ADR_REF },
      data: { classification: "maybe" },
    });
    await expect(store.findByRun(tenantId, runId)).rejects.toThrow(/unknown classification/);
    await prisma.contextItem.updateMany({
      where: { ref: ADR_REF },
      data: { classification: "required" },
    });
  });
});

describe("PrismaRunRepository.setContextContractVersion", () => {
  it("records the contract identity on the Run", async () => {
    await runs.setContextContractVersion(tenantId, runId, FIRST_SHA256);
    const run = await runs.findById(tenantId, runId);
    expect(run?.contextContractVersion).toBe(FIRST_SHA256);
  });

  it("does not write across the tenant boundary", async () => {
    await runs.setContextContractVersion(otherTenantId, runId, "f".repeat(64));
    const run = await runs.findById(tenantId, runId);
    expect(run?.contextContractVersion).toBe(FIRST_SHA256);
  });
});
