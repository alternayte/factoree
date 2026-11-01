-- DI-15.29. A warm snapshot that no WarmSnapshot row names any more and that the provider still holds.

-- CreateTable
CREATE TABLE "RetiredWarmSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetiredWarmSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RetiredWarmSnapshot_adapter_snapshotId_key" ON "RetiredWarmSnapshot"("adapter", "snapshotId");

-- AddForeignKey
ALTER TABLE "RetiredWarmSnapshot" ADD CONSTRAINT "RetiredWarmSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
