-- docs/specs/release-0-1-0.md part 3. The QUEUED state and maxConcurrentRuns (DI-15.13), and the
-- sandboxMaxLive limit (DI-15.14).

-- AlterTable
ALTER TABLE "Run" ADD COLUMN "slotGrantedAt" TIMESTAMP(3);

-- DropIndex
DROP INDEX "Run_productId_idx";

-- CreateIndex
CREATE INDEX "Run_productId_status_idx" ON "Run"("productId", "status");

-- CreateTable
CREATE TABLE "SandboxLease" (
    "id" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sandboxId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evictingSince" TIMESTAMP(3),

    CONSTRAINT "SandboxLease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SandboxLease_adapter_sandboxId_key" ON "SandboxLease"("adapter", "sandboxId");

-- CreateIndex
CREATE INDEX "SandboxLease_adapter_createdAt_idx" ON "SandboxLease"("adapter", "createdAt");

-- A Run that already holds a sandbox passed the gate before PREPARING, so it holds a slot.
UPDATE "Run" SET "slotGrantedAt" = "createdAt" WHERE "spriteId" IS NOT NULL;

-- Every work sandbox a Run records is live until the reaper deletes it.
INSERT INTO "SandboxLease" ("id", "adapter", "runId", "sandboxId", "createdAt")
SELECT gen_random_uuid()::text, "spriteAdapter", "id", "spriteId", "createdAt"
FROM "Run"
WHERE "spriteId" IS NOT NULL AND "spriteAdapter" IS NOT NULL;
