import { describe, expect, it } from "vitest";
import { PrismaRepositorySetupStore } from "~/persistence/prisma/repository-setup.prisma.js";
import type { SetupReport } from "~/domain/setup/setup-report.js";
import { withDatabase, seedTenantProjectAndRun } from "./support/database.js";

const report = (name: string): SetupReport => ({
  parts: [{ kind: "verify", name, passed: false, reason: "it exited with code 1" }],
  observedHosts: [],
  deniedHosts: [],
  egressRecorded: true,
  fakes: [],
  appChanges: [],
});

describe("PrismaRepositorySetupStore.previousWithReport (DI-21.18)", () => {
  it("returns the newest earlier setup of the repository that holds a report", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, productId } = await seedTenantProjectAndRun(prisma);
      const store = new PrismaRepositorySetupStore(prisma);
      // created_at has millisecond precision, so each row waits for a later millisecond.
      const create = async (repositoryFullName: string) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return store.create({ tenantId, productId, repositoryFullName, githubInstallationId: "42", workflowId: `w-${Math.random()}` });
      };

      const older = await create("acme/anthology");
      await store.update(older.id, { report: report("older") });
      const newer = await create("acme/anthology");
      await store.update(newer.id, { report: report("newer") });
      // A setup that ended before its proof holds no report, and must not hide the one before it.
      await create("acme/anthology");
      const other = await create("acme/other");
      await store.update(other.id, { report: report("other") });
      const current = await create("acme/anthology");

      const found = await store.previousWithReport(productId, "acme/anthology", current.createdAt);
      expect(found?.id).toBe(newer.id);
      expect(found?.report?.parts[0]?.name).toBe("newer");
      expect(await store.previousWithReport(productId, "acme/anthology", older.createdAt)).toBeNull();
    });
  });
});
