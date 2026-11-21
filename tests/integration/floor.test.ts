import { describe, expect, it } from "vitest";
import { PrismaFloorReader } from "~/persistence/prisma/floor.prisma.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaSessionPulseStore } from "~/persistence/prisma/session-pulse.prisma.js";
import { withDatabase, seedTenantProjectAndRun } from "./support/database.js";

/** docs/specs/factory-floor.md. The status history, the pulses and the floor read model. */
describe("factory floor", () => {
  it("records every status change of a run, whichever writer makes it", async () => {
    await withDatabase(async (prisma) => {
      const { runId } = await seedTenantProjectAndRun(prisma);
      await new PrismaRunRepository(prisma).updateStatus(runId, "REFINING");
      // The slot grant writes the status without updateStatus.
      await prisma.run.update({ where: { id: runId }, data: { status: "QUEUED" } });
      // A write that keeps the status records nothing.
      await prisma.run.update({ where: { id: runId }, data: { status: "QUEUED", repairCount: 1 } });
      const changes = await prisma.runStatusChange.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });
      expect(changes.map((change) => [change.fromStatus, change.toStatus])).toEqual([
        [null, "RECEIVED"],
        ["RECEIVED", "REFINING"],
        ["REFINING", "QUEUED"],
      ]);
    });
  });

  it("records the status changes of a setup run", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, productId } = await seedTenantProjectAndRun(prisma);
      const setup = await prisma.repositorySetup.create({
        data: { tenantId, productId, repositoryFullName: "acme/app", githubInstallationId: "1", workflowId: "w", status: "queued" },
      });
      await prisma.repositorySetup.update({ where: { id: setup.id }, data: { status: "running" } });
      const changes = await prisma.setupStatusChange.findMany({ where: { setupId: setup.id }, orderBy: { createdAt: "asc" } });
      expect(changes.map((change) => change.toStatus)).toEqual(["queued", "running"]);
    });
  });

  it("shows a running session's newest pulse on the live floor, under its run or its setup", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, productId, runId } = await seedTenantProjectAndRun(prisma);
      const setup = await prisma.repositorySetup.create({
        data: { tenantId, productId, repositoryFullName: "acme/app", githubInstallationId: "1", workflowId: "w", status: "running" },
      });
      const pulses = new PrismaSessionPulseStore(prisma);
      const now = new Date();
      const at = (msAgo: number) => new Date(now.getTime() - msAgo);
      await pulses.record({ tenantId, owner: runId, role: "implementer", toolKind: "read", lastOutputAt: at(10_000), at: at(10_000) });
      await pulses.record({ tenantId, owner: runId, role: "implementer", toolKind: "edit", lastOutputAt: at(5_000), at: at(5_000) });
      await pulses.record({ tenantId, owner: `setup:${setup.id}`, role: "setup", toolKind: "shell", lastOutputAt: at(2_000), at: at(2_000) });
      const floor = await new PrismaFloorReader(prisma).live(tenantId, now);
      expect(floor.lines.map((line) => line.productId)).toEqual([productId]);
      expect(floor.runs.map((run) => run.id)).toEqual([runId]);
      expect(floor.setups.map((entry) => entry.id)).toEqual([setup.id]);
      expect(floor.pulses.map((pulse) => [pulse.runId, pulse.setupId, pulse.toolKind])).toEqual([
        [null, setup.id, "shell"],
        [runId, null, "edit"],
      ]);
    });
  });

  it("marks a run from before the status history as approximate, from its stage rows", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
      const created = new Date(Date.now() - 60 * 60_000);
      await prisma.runStatusChange.deleteMany({ where: { runId } });
      await prisma.$executeRaw`ALTER TABLE "Run" DISABLE TRIGGER "run_status_change_trigger"`;
      await prisma.run.update({ where: { id: runId }, data: { status: "FAILED", createdAt: created, completedAt: new Date(created.getTime() + 30 * 60_000) } });
      await prisma.$executeRaw`ALTER TABLE "Run" ENABLE TRIGGER "run_status_change_trigger"`;
      const stage = (name: string, attempt: number, minutes: number) => ({
        tenantId,
        runId,
        stage: name,
        attempt,
        startedAt: new Date(created.getTime() + minutes * 60_000),
        endedAt: new Date(created.getTime() + (minutes + 1) * 60_000),
      });
      await prisma.runStage.createMany({ data: [stage("implementer", 1, 5), stage("verify", 1, 10), stage("implementer", 2, 12)] });
      const floor = await new PrismaFloorReader(prisma).live(tenantId, new Date());
      const [run] = floor.runs;
      expect(run?.approximate).toBe(true);
      expect(run?.statuses.map((change) => change.status)).toEqual(["RECEIVED", "IMPLEMENTING", "VERIFYING", "REPAIRING", "FAILED"]);
    });
  });

  it("keeps the runs of another tenant off the floor", async () => {
    await withDatabase(async (prisma) => {
      await seedTenantProjectAndRun(prisma);
      const other = await seedTenantProjectAndRun(prisma);
      const floor = await new PrismaFloorReader(prisma).live(other.tenantId, new Date());
      expect(floor.runs.map((run) => run.id)).toEqual([other.runId]);
    });
  });
});
