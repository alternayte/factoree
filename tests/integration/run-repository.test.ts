import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDatabase, seedTenantProjectAndRun } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaWebhookLog } from "~/persistence/prisma/webhook-log.prisma.js";
import { PrismaRunDraftStore } from "~/persistence/prisma/run-draft.prisma.js";
import { PrismaWaitingRunStore } from "~/persistence/prisma/waiting-run.prisma.js";
import { createRunActivities } from "~/activities/run.activities.js";
import type { AgentRunWorkflowInput } from "~/workflows/agent-run.workflow.js";
import type { Blocker } from "~/domain/runs/blocker-wait.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";

let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let tenantA = "";
let tenantB = "";
let productA = "";

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
  const a = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-a", name: "A" } });
  const b = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-b", name: "B" } });
  tenantA = a.id;
  tenantB = b.id;
  const product = await prisma.product.create({
    data: { tenantId: tenantA, slug: "demo", name: "Demo", linearTeamKey: "TEAM", linearTeamId: "team-1" },
  });
  productA = product.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  await stop();
});

const input = (sessionId: string) => ({
  tenantId: tenantA,
  productId: productA,
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

  // docs/specs/run-recovery.md. A follow-up run shares the session and has a workflow of its own.
  it("creates a follow-up run in the same session, and finds the newest run of the session", async () => {
    const repository = new PrismaRunRepository(prisma);
    const failed = await repository.createIfAbsent(input("session-follow-up"));
    const followUp = await repository.createIfAbsent({
      ...input("session-follow-up"),
      temporalWorkflowId: `linear:ws-a:session-follow-up:follow-up:${failed.run.id}`,
      followUpOfRunId: failed.run.id,
    });

    expect(followUp.created).toBe(true);
    expect(followUp.run.id).not.toBe(failed.run.id);
    expect((await repository.findByAgentSession(tenantA, "session-follow-up"))?.id).toBe(followUp.run.id);
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

  it("stores the organization skills SHA beside the base SHA (SDD section 55)", async () => {
    const repository = new PrismaRunRepository(prisma);
    const created = await repository.createIfAbsent(input("session-organization-skills-sha"));
    await repository.setSandbox(tenantA, created.run.id, {
      spriteId: "sprite-organization-skills",
      adapter: "fake",
      retainUntil: new Date(),
      baseSha: "d".repeat(40),
      implementerRunner: "opencode",
      organizationSkillsSha: "e".repeat(40),
    });
    const stored = await repository.findById(tenantA, created.run.id);
    expect(stored?.organizationSkillsSha).toBe("e".repeat(40));
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

  it("stores the normalized failure category beside the failure reason (SDD section 67)", async () => {
    const repository = new PrismaRunRepository(prisma);
    const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
    await repository.updateStatus(runId, "FAILED", {
      failureReason: "VERIFICATION_FAILED",
      failureCategory: "VERIFICATION",
      completedAt: new Date(),
    });
    const stored = await repository.findById(tenantId, runId);
    expect(stored?.failureReason).toBe("VERIFICATION_FAILED");
    expect(stored?.failureCategory).toBe("VERIFICATION");
  });

  it("leaves the category null on a Run that did not fail", async () => {
    const repository = new PrismaRunRepository(prisma);
    const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
    await repository.updateStatus(runId, "READY_FOR_HUMAN", { completedAt: new Date() });
    const stored = await repository.findById(tenantId, runId);
    expect(stored?.failureCategory).toBeNull();
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
    await runs.setProofPack(tenantId, runId, { sha256: "a".repeat(64), postedAt, document: { version: 1, runId } });
    const reloaded = await runs.findById(tenantId, runId);
    expect(reloaded?.proofPackSha256).toBe("a".repeat(64));
    expect(reloaded?.proofPackDocument).toEqual({ version: 1, runId });
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
        document: {},
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

// docs/specs/draft-of-failed-run.md, DI-21.76. The draft decides on the review of the patch it
// publishes: a blocker of an earlier attempt reviewed another patch and does not stand.
describe("PrismaRunDraftStore", () => {
  const finding = (runId: string, attempt: number) => ({
    tenantId: tenantA,
    runId,
    attempt,
    verdict: "fail",
    findingKey: `RV-${attempt}`,
    severity: "blocker",
    category: "correctness",
    requirement: "AC-1",
    evidence: "src/a.ts:1",
    description: "It throws.",
    blocking: true,
    decisionReason: "a blocker",
  });

  it("reads the review of the last patch only, and keeps the failure when it writes DRAFT_PUBLISHED", async () => {
    const repository = new PrismaRunRepository(prisma);
    const drafts = new PrismaRunDraftStore(prisma);
    const { run } = await repository.createIfAbsent(input("session-draft"));
    await repository.updateStatus(run.id, "FAILED", { failureReason: "VALIDATION_FAILED", failureMessage: "AC-1 failed." });
    await prisma.reviewFinding.create({ data: finding(run.id, 1) });
    await repository.recordLastPatch(tenantA, run.id, Buffer.from("diff --git a/x b/x\n").toString("base64"), 2);

    const facts = await drafts.facts(tenantA, run.id);
    expect(facts).toMatchObject({ status: "FAILED", hasPatch: true, patchAttempt: 2, findings: [], reviewed: false });
    expect(await drafts.facts(tenantB, run.id)).toBeNull();

    await prisma.reviewFinding.create({ data: finding(run.id, 2) });
    expect((await drafts.facts(tenantA, run.id))?.findings.map((row) => row.key)).toEqual(["RV-2"]);

    expect(await drafts.markPublished(tenantA, run.id)).toBe(true);
    const published = await repository.findById(tenantA, run.id);
    expect(published?.status).toBe("DRAFT_PUBLISHED");
    expect(published?.failureReason).toBe("VALIDATION_FAILED");
  });
});

// docs/specs/blocked-by-wait.md. The waiting record is the Run row, and the workflow adopts it.
describe("PrismaWaitingRunStore", () => {
  const blocker = (identifier: string, state: string): Blocker => ({
    issueId: `issue-${identifier}`,
    identifier,
    url: null,
    state,
    pullRequestUrl: null,
  });
  const waitingInput = (sessionId: string, blockers: Blocker[] | null) => ({
    ...input(sessionId),
    linearIssueId: `issue-of-${sessionId}`,
    workItemTitle: "Blocked",
    workItemUrl: null,
    startInput: { tenantId: tenantA, agentSessionId: sessionId } as AgentRunWorkflowInput,
    blockers,
  });
  const activities = () => {
    const redactor = new Redactor();
    return createRunActivities({
      runs: new PrismaRunRepository(prisma),
      slots: { claim: () => Promise.resolve({ granted: true }) },
      logger: createLogger({ level: "error", redactor, sink: () => undefined }),
      runners: { all: () => [] } as never,
      agentSession: {} as never,
      redactor,
    });
  };

  it("lets the workflow adopt the waiting row as RECEIVED, once, and keeps its blockers", async () => {
    const store = new PrismaWaitingRunStore(prisma);
    const { runId, created } = await store.createWaiting(waitingInput("session-wait-1", [blocker("FAC-1", "completed")]));
    expect(created).toBe(true);
    expect((await store.listWaiting(tenantA)).map((run) => run.id)).toContain(runId);
    expect(await store.listWaiting(tenantB)).toEqual([]);
    // A second hold of the same workflow id writes no second row.
    expect(await store.createWaiting(waitingInput("session-wait-1", null))).toEqual({ runId, created: false });

    const first = await activities().createRun(input("session-wait-1"));
    expect(first).toEqual({ runId, created: true, adopted: true });
    const row = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe("RECEIVED");
    expect(row.blockers).toEqual([blocker("FAC-1", "completed")]);
    // An activity retry finds its own row and creates nothing.
    expect(await activities().createRun(input("session-wait-1"))).toEqual({ runId, created: false });
    expect(await store.listWaiting(tenantA)).not.toContainEqual(expect.objectContaining({ id: runId }));
    // A stop after the adoption no longer reaches the row: the workflow takes the signal.
    expect(await store.cancel(tenantA, runId, { source: "linear" }, new Date())).toBeNull();
  });

  it("cancels a waiting run, and the workflow that starts after it ends with no work", async () => {
    const store = new PrismaWaitingRunStore(prisma);
    const { runId } = await store.createWaiting(waitingInput("session-wait-2", [blocker("FAC-1", "started")]));
    const cancelled = await store.cancel(tenantB, runId, { source: "linear" }, new Date());
    expect(cancelled).toBeNull();
    expect(await store.cancel(tenantA, runId, { source: "factoree_ui", by: "Nate" }, new Date("2026-11-12T10:00:00.000Z"))).toMatchObject({
      id: runId,
    });
    const row = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(row).toMatchObject({
      status: "CANCELLED",
      failureReason: "STOPPED_BY_HUMAN",
      stopSource: "factoree_ui",
      stopRequestedBy: "Nate",
      completedAt: new Date("2026-11-12T10:00:00.000Z"),
    });
    expect(await activities().createRun(input("session-wait-2"))).toEqual({ runId, created: false, ended: true, status: "CANCELLED" });
    expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("CANCELLED");
  });

  it("writes the blockers only while the row holds the blockers the sweep read", async () => {
    const store = new PrismaWaitingRunStore(prisma);
    const { runId } = await store.createWaiting(waitingInput("session-wait-3", null));
    const read = [blocker("FAC-1", "started"), blocker("FAC-2", "backlog")];
    expect(await store.replaceBlockers(runId, null, read)).toBe(true);
    // A second sweep that read before the first one wrote loses.
    expect(await store.replaceBlockers(runId, null, [blocker("FAC-3", "started")])).toBe(false);
    // jsonb equality ignores the key order of the stored objects.
    const reordered = read.map((entry) => ({ state: entry.state, pullRequestUrl: null, url: null, identifier: entry.identifier, issueId: entry.issueId }));
    expect(await store.replaceBlockers(runId, reordered, [])).toBe(true);
    expect((await store.findWaiting(tenantA, runId))?.blockers).toEqual([]);
  });

  it("names the pull request of the newest Factoree run of a blocker issue", async () => {
    const repository = new PrismaRunRepository(prisma);
    const store = new PrismaWaitingRunStore(prisma);
    const older = await repository.createIfAbsent({ ...input("session-blocker-old"), linearIssueId: "issue-blocker" });
    await prisma.run.update({ where: { id: older.run.id }, data: { pullRequestUrl: "https://github.com/o/r/pull/1", createdAt: new Date("2026-01-01") } });
    const newer = await repository.createIfAbsent({ ...input("session-blocker-new"), linearIssueId: "issue-blocker" });
    await prisma.run.update({ where: { id: newer.run.id }, data: { pullRequestUrl: "https://github.com/o/r/pull/2" } });
    expect(await store.pullRequestsOf(tenantA, ["issue-blocker", "issue-none"])).toEqual(new Map([["issue-blocker", "https://github.com/o/r/pull/2"]]));
    expect(await store.pullRequestsOf(tenantB, ["issue-blocker"])).toEqual(new Map());
  });
});
