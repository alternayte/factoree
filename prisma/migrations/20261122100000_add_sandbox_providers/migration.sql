-- docs/specs/sandbox-provider-spillover.md. The install holds a list of sandbox providers.
CREATE TABLE "SandboxProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT,
    "apiKeyCipher" TEXT,
    "maxLive" INTEGER,
    "vcpus" INTEGER,
    "memoryMb" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "downUntil" TIMESTAMP(3),
    "downReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandboxProvider_pkey" PRIMARY KEY ("id")
);

-- The provider of the install settings becomes entry 1 at priority 1. Its id is its type name,
-- the value every lease, warm snapshot, retired snapshot and run already holds as its adapter,
-- so each existing row already names it, and a sandbox ref in a running workflow still routes.
INSERT INTO "SandboxProvider" ("id", "name", "type", "url", "apiKeyCipher", "maxLive", "vcpus", "memoryMb", "priority", "enabled", "updatedAt")
SELECT "sandboxProvider",
       CASE "sandboxProvider" WHEN 'kiln' THEN 'Kiln' WHEN 'e2b' THEN 'E2B' WHEN 'fly-sprites' THEN 'Fly Sprites' ELSE 'Local' END,
       "sandboxProvider", "sandboxUrl", "sandboxApiKeyCipher", "sandboxMaxLive", "sandboxVcpus", "sandboxMemoryMb", 1, true, CURRENT_TIMESTAMP
FROM "InstallSettings"
WHERE "id" = 'install' AND "sandboxProvider" IS NOT NULL;

ALTER TABLE "InstallSettings" DROP COLUMN "sandboxProvider",
DROP COLUMN "sandboxUrl",
DROP COLUMN "sandboxApiKeyCipher",
DROP COLUMN "sandboxMaxLive",
DROP COLUMN "sandboxVcpus",
DROP COLUMN "sandboxMemoryMb";

-- A held lease is one of the three slots a run takes at start.
ALTER TABLE "SandboxLease" ADD COLUMN "held" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "SandboxLease_runId_idx" ON "SandboxLease"("runId");

-- The provider a run is pinned to. A run that started before this release ran on entry 1.
ALTER TABLE "Run" ADD COLUMN "sandbox_provider_id" TEXT;
UPDATE "Run" SET "sandbox_provider_id" = "spriteAdapter" WHERE "spriteAdapter" IS NOT NULL;

ALTER TABLE "Product" ADD COLUMN "sandbox_provider_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "BuildAheadFailure" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "repositoryUrl" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "failedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuildAheadFailure_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BuildAheadFailure_tenantId_providerId_repositoryUrl_key" ON "BuildAheadFailure"("tenantId", "providerId", "repositoryUrl");

ALTER TABLE "BuildAheadFailure" ADD CONSTRAINT "BuildAheadFailure_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
