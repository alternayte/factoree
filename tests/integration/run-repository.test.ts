import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDatabase } from "./support/database.js";
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
