import { describe, expect, it } from "vitest";
import { PrismaRunEventStore } from "~/persistence/prisma/run-event.prisma.js";
import type { NewRunEvent } from "~/domain/diagnostics/run-event.js";
import { withDatabase, seedTenantProjectAndRun } from "./support/database.js";

const failure = (tenantId: string, runId: string, key: string): NewRunEvent => ({
  tenantId,
  subject: { runId },
  stage: "PREPARING",
  attempt: 0,
  role: null,
  kind: "command_failed",
  message: "The bootstrap command failed with exit code 1.",
  detail: { step: "bootstrap", command: "npm ci", exitCode: 1, durationMs: 900, log: "npm ERR!", egress: "not_recorded", deniedHosts: [], hostHints: [] },
  idempotencyKey: key,
});

/** docs/specs/run-diagnostics.md. The `run_event` table. */
describe("PrismaRunEventStore", () => {
  it("writes one row per idempotency key, and reads the events in order with a cursor", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
      const store = new PrismaRunEventStore(prisma);
      await store.record(failure(tenantId, runId, "a"));
      await store.record(failure(tenantId, runId, "a"));
      await store.record(failure(tenantId, runId, "b"));
      const first = await store.list({ tenantId, subject: { runId }, limit: 1 });
      expect(first.items.map((event) => event.idempotencyKey)).toEqual(["a"]);
      const second = await store.list({ tenantId, subject: { runId }, limit: 1, cursor: first.nextCursor ?? "" });
      expect(second.items.map((event) => event.idempotencyKey)).toEqual(["b"]);
      expect(second.nextCursor).toBeNull();
      const newest = await store.newest(tenantId, { runId }, ["command_failed"]);
      expect(newest?.idempotencyKey).toBe("b");
    });
  });

  it("refuses a row of another tenant on read", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
      const store = new PrismaRunEventStore(prisma);
      await store.record(failure(tenantId, runId, "a"));
      const [event] = (await store.list({ tenantId, subject: { runId }, limit: 10 })).items;
      expect(await store.find("another-tenant", event?.id ?? "")).toBeNull();
      expect((await store.list({ tenantId: "another-tenant", subject: { runId }, limit: 10 })).items).toEqual([]);
    });
  });

  it("holds the rule that an event names exactly one run or one setup run", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
      await expect(
        prisma.$executeRaw`insert into run_event (id, tenant_id, stage, attempt, kind, message, detail, idempotency_key)
          values ('x', ${tenantId}, 'PREPARING', 0, 'run_ended', 'm', '{}'::jsonb, 'k')`,
      ).rejects.toThrow();
      expect(runId).toBeTruthy();
    });
  });
});
