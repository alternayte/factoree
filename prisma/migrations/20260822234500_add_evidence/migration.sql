-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "validationAssertionId" TEXT,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageRef" TEXT,
    "metadata" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Evidence_runId_idempotencyKey_key" ON "Evidence"("runId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Evidence_tenantId_runId_idx" ON "Evidence"("tenantId", "runId");

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
