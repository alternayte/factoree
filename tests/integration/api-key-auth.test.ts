import { describe, expect, it } from "vitest";
import { createAuth } from "~/http/auth/auth.js";
import { principalFor } from "~/http/auth/membership.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { withDatabase } from "./support/database.js";

const MASTER_KEY = "11".repeat(32);

/**
 * docs/specs/release-0-1-0.md, docs/specs/run-diagnostics.md. A `fct_` key that a signed-in admin
 * created opens the administration API as that person, so an agent can read a run with it.
 */
describe("API key sign-in", () => {
  it("resolves a created key to its user and memberships", async () => {
    await withDatabase(async (prisma) => {
      const tenant = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-key", name: "Key" } });
      const now = new Date();
      await prisma.user.create({ data: { id: "user-key", name: "Admin", email: "admin@example.test", emailVerified: false, createdAt: now, updatedAt: now } });
      await prisma.account.create({ data: { id: "acc-key", accountId: "linear-user-key", providerId: "linear", userId: "user-key", createdAt: now, updatedAt: now } });
      await prisma.linearMember.create({ data: { linearUserId: "linear-user-key", tenantId: tenant.id, admin: true } });
      const auth = createAuth({
        prisma,
        publicUrl: "https://factoree.example.test",
        masterKey: MASTER_KEY,
        linear: null,
        logger: createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
      });
      const created = await auth.api.createApiKey({ body: { userId: "user-key", name: "agent" } });
      expect(created.key.startsWith("fct_")).toBe(true);
      const verified = await auth.api.verifyApiKey({ body: { key: created.key } });
      expect(verified.valid, JSON.stringify(verified.error)).toBe(true);
      const principal = await principalFor(prisma, verified.key?.referenceId ?? "", verified.key?.id ?? null, null);
      expect(principal?.memberships.map((membership) => membership.linearWorkspaceId)).toEqual(["ws-key"]);
    });
  });
});
