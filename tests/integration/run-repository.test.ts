import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDatabase, seedTenantProjectAndRun } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaWebhookLog } from "~/persistence/prisma/webhook-log.prisma.js";

let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let tenantA = "";
let tenantB = "";
let projectA = "";

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
  const a = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-a", name: "A" } });
  const b = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-b", name: "B" } });
  tenantA = a.id;
  tenantB = b.id;
  const project = await prisma.project.create({
    data: { tenantId: tenantA, key: "demo", name: "Demo", primaryRepository: "acme/demo" },
  });
  projectA = project.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  await stop();
});

const input = (sessionId: string) => ({
  tenantId: tenantA,
  projectId: projectA,
  linearIssueId: "issue-1",
  linearAgentSessionId: sessionId,
  temporalWorkflowId: `linear:ws-a:${sessionId}`,
  autonomyLevel: "L2",
});

describe("PrismaRunRepository", () => {
  it("creates one Run and reports creation", async () => {
    const repository = new PrismaRunRepository(prisma);
    const result = await repository.createIfAbsent(input("session-1"));
    expect(result.created).toBe(true);
    expect(result.run.status).toBe("RECEIVED");
    expect(result.run.tenantId).toBe(tenantA);
  });

  it("returns the same Run for a repeated agent session", async () => {
    const repository = new PrismaRunRepository(prisma);
    const first = await repository.createIfAbsent(input("session-2"));
    const second = await repository.createIfAbsent(input("session-2"));
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(await prisma.run.count({ where: { linearAgentSessionId: "session-2" } })).toBe(1);
  });

  it("hides a Run from another tenant", async () => {
    const repository = new PrismaRunRepository(prisma);
    const created = await repository.createIfAbsent(input("session-3"));
    expect(await repository.findById(tenantB, created.run.id)).toBeNull();
    expect(await repository.findById(tenantA, created.run.id)).not.toBeNull();
  });

  it("updates the status and records the completion time", async () => {
    const repository = new PrismaRunRepository(prisma);
    const created = await repository.createIfAbsent(input("session-4"));
    const completedAt = new Date();
    const updated = await repository.updateStatus(created.run.id, "CANCELLED", {
      failureReason: "STOPPED_BY_HUMAN",
      completedAt,
    });
    expect(updated.status).toBe("CANCELLED");
    expect(updated.failureReason).toBe("STOPPED_BY_HUMAN");
    expect(updated.completedAt?.getTime()).toBe(completedAt.getTime());
  });

  it("records the sandbox, lists it after the retention window, and clears it", async () => {
    const repository = new PrismaRunRepository(prisma);
    const created = await repository.createIfAbsent(input("session-5"));
    const retainUntil = new Date(Date.now() - 1_000);
    await repository.setSandbox(tenantA, created.run.id, {
      spriteId: "sprite-5",
      adapter: "fake",
      retainUntil,
      baseSha: "b".repeat(40),
      implementerRunner: "opencode",
    });

    const stored = await repository.findById(tenantA, created.run.id);
    expect(stored?.spriteId).toBe("sprite-5");
    expect(stored?.spriteAdapter).toBe("fake");
    expect(stored?.baseSha).toBe("b".repeat(40));
    expect(stored?.implementerRunner).toBe("opencode");

    const expired = await repository.listExpiredSandboxes(new Date(), 10);
    expect(expired).toContainEqual({
      tenantId: tenantA,
      runId: created.run.id,
      spriteId: "sprite-5",
      adapter: "fake",
    });

    await repository.clearSandbox(tenantA, created.run.id);
    const cleared = await repository.findById(tenantA, created.run.id);
    expect(cleared?.spriteId).toBeNull();
    expect(cleared?.spriteRetainUntil).toBeNull();
    expect(await repository.listExpiredSandboxes(new Date(), 10)).toHaveLength(0);
  });

  it("refuses to record a sandbox for a Run of another tenant, and reports the refusal", async () => {
    const repository = new PrismaRunRepository(prisma);
    const created = await repository.createIfAbsent(input("session-6"));
    const patch = {
      spriteId: "sprite-6",
      adapter: "fake",
      retainUntil: new Date(),
      baseSha: "c".repeat(40),
      implementerRunner: "opencode",
    };
    // A wrong tenant reaches no row. A silent success would leave the sandbox unreferenced, and
    // the reaper could never find it.
    await expect(repository.setSandbox(tenantB, created.run.id, patch)).rejects.toThrow(
      /received the sandbox reference/,
    );
    const stored = await repository.findById(tenantA, created.run.id);
    expect(stored?.spriteId).toBeNull();
  });

  it("reports the sandbox that setSandbox replaced", async () => {
    const repository = new PrismaRunRepository(prisma);
    const created = await repository.createIfAbsent(input("session-7"));
    const patch = (spriteId: string) => ({
      spriteId,
      adapter: "fake",
      retainUntil: new Date(),
      baseSha: "d".repeat(40),
      implementerRunner: "opencode",
    });

    const first = await repository.setSandbox(tenantA, created.run.id, patch("sprite-7a"));
    expect(first).toEqual({ spriteId: null, adapter: null });

    const second = await repository.setSandbox(tenantA, created.run.id, patch("sprite-7b"));
    expect(second).toEqual({ spriteId: "sprite-7a", adapter: "fake" });
  });

  it("gives two concurrent writers a different superseded sandbox each", async () => {
    const repository = new PrismaRunRepository(prisma);
    const created = await repository.createIfAbsent(input("session-8"));
    const patch = (spriteId: string) => ({
      spriteId,
      adapter: "fake",
      retainUntil: new Date(),
      baseSha: "e".repeat(40),
      implementerRunner: "opencode",
    });
    await repository.setSandbox(tenantA, created.run.id, patch("sprite-8-original"));

    // The row lock serializes the two writers, so each one learns what its own write replaced.
    const [left, right] = await Promise.all([
      repository.setSandbox(tenantA, created.run.id, patch("sprite-8-left")),
      repository.setSandbox(tenantA, created.run.id, patch("sprite-8-right")),
    ]);

    const superseded = [left.spriteId, right.spriteId].sort();
    const stored = await repository.findById(tenantA, created.run.id);
    const winner = stored?.spriteId;
    expect(winner === "sprite-8-left" || winner === "sprite-8-right").toBe(true);
    const loser = winner === "sprite-8-left" ? "sprite-8-right" : "sprite-8-left";
    // Every sandbox except the one the Run still holds was reported to exactly one caller, so
    // nothing is left unreferenced.
    expect(superseded).toEqual(["sprite-8-original", loser].sort());
  });

});

describe("PrismaRunRepository.setValidationContractVersion", () => {
  it("writes the frozen Validation Contract hash to the Run", async () => {
    const runs = new PrismaRunRepository(prisma);
    const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
    await runs.setValidationContractVersion(tenantId, runId, "a".repeat(64));
    const reloaded = await runs.findById(tenantId, runId);
    expect(reloaded?.validationContractVersion).toBe("a".repeat(64));
  });

  it("throws when it reaches no Run of that tenant, because a silent success hides a caller defect", async () => {
    const runs = new PrismaRunRepository(prisma);
    const { runId } = await seedTenantProjectAndRun(prisma);
    await expect(
      runs.setValidationContractVersion("other-tenant", runId, "b".repeat(64)),
    ).rejects.toThrow();
  });
});

describe("PrismaRunRepository.setPublication", () => {
  it("writes the publication facts to the Run", async () => {
    const runs = new PrismaRunRepository(prisma);
    const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
    await runs.setPublication(tenantId, runId, {
      patchSha256: "c".repeat(64),
      commitSha: "d".repeat(40),
      pullRequestUrl: "https://github.com/acme/demo/pull/1",
    });
    const reloaded = await runs.findById(tenantId, runId);
    expect(reloaded?.patchSha256).toBe("c".repeat(64));
    expect(reloaded?.commitSha).toBe("d".repeat(40));
    expect(reloaded?.pullRequestUrl).toBe("https://github.com/acme/demo/pull/1");
  });

  it("throws when it reaches no Run of that tenant, because a silent success hides a caller defect", async () => {
    const runs = new PrismaRunRepository(prisma);
    const { runId } = await seedTenantProjectAndRun(prisma);
    await expect(
      runs.setPublication("other-tenant", runId, {
        patchSha256: "e".repeat(64),
        commitSha: "f".repeat(40),
        pullRequestUrl: "https://github.com/acme/demo/pull/2",
      }),
    ).rejects.toThrow();
  });
});

describe("PrismaRunRepository.setProofPack", () => {
  it("writes the Proof Pack facts to the Run", async () => {
    const runs = new PrismaRunRepository(prisma);
    const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
    const postedAt = new Date("2026-02-01T10:00:00.000Z");
    await runs.setProofPack(tenantId, runId, { sha256: "a".repeat(64), postedAt });
    const reloaded = await runs.findById(tenantId, runId);
    expect(reloaded?.proofPackSha256).toBe("a".repeat(64));
    expect(reloaded?.proofPackPostedAt?.toISOString()).toBe(postedAt.toISOString());
  });

  it("reports no Proof Pack before one is posted", async () => {
    const runs = new PrismaRunRepository(prisma);
    const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
    const reloaded = await runs.findById(tenantId, runId);
    expect(reloaded?.proofPackSha256).toBeNull();
    expect(reloaded?.proofPackPostedAt).toBeNull();
  });

  it("throws when it reaches no Run of that tenant, because a silent success hides a caller defect", async () => {
    const runs = new PrismaRunRepository(prisma);
    const { runId } = await seedTenantProjectAndRun(prisma);
    await expect(
      runs.setProofPack("other-tenant", runId, {
        sha256: "b".repeat(64),
        postedAt: new Date("2026-02-01T10:00:00.000Z"),
      }),
    ).rejects.toThrow();
  });
});

describe("PrismaWebhookLog", () => {
  it("accepts a delivery once", async () => {
    const log = new PrismaWebhookLog(prisma);
    const first = await log.recordIfNew({ tenantId: tenantA, deliveryId: "delivery-1", eventType: "AgentSessionEvent" });
    const second = await log.recordIfNew({ tenantId: tenantA, deliveryId: "delivery-1", eventType: "AgentSessionEvent" });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});
