import { describe, expect, it } from "vitest";
import { PrismaRetroGatewayStore, PrismaRetroStore, PrismaTranscriptStore } from "~/persistence/prisma/retro.prisma.js";
import { withDatabase, seedTenantProjectAndRun } from "./support/database.js";

/** docs/specs/retro-agent.md. The retro store: the run window, title dedupe and retention. */
describe("retro store", () => {
  it("exports only the ended runs of the product inside the window", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, productId, runId } = await seedTenantProjectAndRun(prisma);
      const windowStart = new Date("2026-11-18T09:00:00Z");
      const windowEnd = new Date("2026-11-25T09:00:00Z");
      await prisma.run.update({ where: { id: runId }, data: { status: "FAILED", completedAt: new Date("2026-11-20T09:00:00Z"), followUpReply: "use the staging seed" } });
      const store = new PrismaRetroStore(prisma);
      const inside = await store.exportRuns(tenantId, productId, windowStart, windowEnd, 200);
      expect(inside.map((run) => [run.id, run.followUpReply])).toEqual([[runId, "use the staging seed"]]);
      // A run that ended at the start of the window belongs to the retro before it.
      await prisma.run.update({ where: { id: runId }, data: { completedAt: windowStart } });
      expect(await store.exportRuns(tenantId, productId, windowStart, windowEnd, 200)).toEqual([]);
      // A run still open is no retro input.
      await prisma.run.update({ where: { id: runId }, data: { status: "IMPLEMENTING", completedAt: new Date("2026-11-20T09:00:00Z") } });
      expect(await store.exportRuns(tenantId, productId, windowStart, windowEnd, 200)).toEqual([]);
    });
  });

  it("stores a finding whose title an open finding holds as already proposed", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, productId } = await seedTenantProjectAndRun(prisma);
      const store = new PrismaRetroStore(prisma);
      const start = (workflowId: string) =>
        store.start({ tenantId, workflowId, trigger: "manual", windowStart: null, windowEnd: new Date(), promptVersion: "retro@1", productIds: [productId] });
      const finding = { kind: "factory" as const, title: "The seed  step times out", description: "d", runIds: [], signalResultIds: [], webResultIds: [], repositories: [] };
      const first = await start("retro-a");
      await store.storeFindings({ tenantId, retroId: first.id, productId, findings: [{ ...finding, duplicateOfId: null }] });
      const open = await store.openFindingsByTitle(tenantId, productId);
      const original = open.get("the seed step times out");
      expect(original).toBeDefined();
      const second = await start("retro-b");
      await store.storeFindings({ tenantId, retroId: second.id, productId, findings: [{ ...finding, title: "the seed step times out", duplicateOfId: original! }] });
      const detail = await store.detail(tenantId, second.id);
      expect(detail?.findings.map((entry) => [entry.status, entry.duplicateOfId, entry.duplicateOfRetroId])).toEqual([
        ["already_proposed", original, first.id],
      ]);
      // A start with the same workflow id reads the same retro.
      expect((await start("retro-a")).id).toBe(first.id);
    });
  });

  it("pages the retros newest first by cursor", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, productId } = await seedTenantProjectAndRun(prisma);
      const store = new PrismaRetroStore(prisma);
      const ids: string[] = [];
      for (const [index, workflowId] of ["retro-1", "retro-2", "retro-3"].entries()) {
        const retro = await store.start({ tenantId, workflowId, trigger: "manual", windowStart: null, windowEnd: new Date(), promptVersion: "retro@1", productIds: [productId] });
        await prisma.retro.update({ where: { id: retro.id }, data: { startedAt: new Date(Date.UTC(2026, 10, 20 + index)) } });
        ids.push(retro.id);
      }
      const first = await store.list(tenantId, 2);
      expect(first.items.map((retro) => retro.id)).toEqual([ids[2], ids[1]]);
      const second = await store.list(tenantId, 2, first.nextCursor!);
      expect(second).toEqual({ items: [expect.objectContaining({ id: ids[0] })], nextCursor: null });
      // A cursor of another tenant's retro reads nothing.
      expect(await store.list("another-tenant", 2, ids[0])).toEqual({ items: [], nextCursor: null });
    });
  });

  // docs/specs/retro-web-research.md. One statement takes a call and its cost, so a limit and the
  // cost cap hold, and an ended session takes nothing.
  it("reserves gateway calls up to the limit and the cost cap", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, productId } = await seedTenantProjectAndRun(prisma);
      const retro = await new PrismaRetroStore(prisma).start({ tenantId, workflowId: "retro-g", trigger: "manual", windowStart: null, windowEnd: new Date(), promptVersion: "retro@2", productIds: [productId] });
      const store = new PrismaRetroGatewayStore(prisma);
      const now = new Date();
      const id = await store.open({ tenantId, retroId: retro.id, productId, tokenSha256: "sha-1", webResearch: true, costLeftUsd: 0.02, expiresAt: new Date(now.getTime() + 60_000) });
      expect(await store.reserve(id, "searches", 2, 0.007, now)).toBe(true);
      expect(await store.reserve(id, "searches", 2, 0.007, now)).toBe(true);
      // The limit of 2 searches holds.
      expect(await store.reserve(id, "searches", 2, 0.007, now)).toBe(false);
      // 0.014 spent: one more 0.007 page passes the 0.02 cap.
      expect(await store.reserve(id, "pages", 40, 0.007, now)).toBe(false);
      expect(await store.reserve(id, "pages", 40, 0.001, now)).toBe(true);
      const [session] = await store.storeWebResults({ id, tenantId, retroId: retro.id, productId }, [
        { kind: "search", query: "q", url: "https://example.com/a", title: "A", publishedDate: null, content: "snippet", sha256: "x" },
      ]);
      expect(await store.searched(id, "https://example.com/a")).toBe(true);
      expect(await store.searched(id, "https://example.com/b")).toBe(false);
      const evidence = await store.evidence(id);
      expect(evidence.webResultIds).toEqual([session!.id]);
      expect(evidence.spentUsd).toBeCloseTo(0.015);
      await store.end(id, now);
      expect(await store.reserve(id, "signalCalls", 50, 0, now)).toBe(false);
    });
  });

  it("deletes kept transcripts and signal results past the product's retention", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, productId, runId } = await seedTenantProjectAndRun(prisma);
      await prisma.product.update({ where: { id: productId }, data: { retroRetentionDays: 7 } });
      const transcripts = new PrismaTranscriptStore(prisma, () => Promise.resolve(null));
      await transcripts.keep({ tenantId, productId, runId, role: "implementer", attempt: 1, text: "old output", idempotencyKey: "old" });
      await transcripts.keep({ tenantId, productId, runId, role: "implementer", attempt: 2, text: "new output", idempotencyKey: "new" });
      const now = new Date();
      await prisma.agentTranscript.updateMany({ where: { idempotencyKey: "old" }, data: { createdAt: new Date(now.getTime() - 8 * 24 * 60 * 60_000) } });
      const store = new PrismaRetroStore(prisma);
      const retro = await store.start({ tenantId, workflowId: "retro-c", trigger: "manual", windowStart: null, windowEnd: now, promptVersion: "retro@1", productIds: [productId] });
      await store.storeSignalResults(tenantId, retro.id, productId, [
        { sourceName: "sentry", sourceKind: "errors", queryName: "new-issues", content: "TypeError", sha256: "x", bytes: 9 },
      ]);
      await prisma.signalResult.updateMany({ data: { createdAt: new Date(now.getTime() - 8 * 24 * 60 * 60_000) } });

      expect(await store.deleteExpired(now, null)).toEqual({ transcripts: 1, signalResults: 1, webResults: 0 });
      expect((await transcripts.forRun(tenantId, runId)).map((entry) => entry.text)).toEqual(["new output"]);
    });
  });
});
