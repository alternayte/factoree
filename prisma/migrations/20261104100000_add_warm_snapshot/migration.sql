-- docs/specs/kiln-sandbox-provider.md. One warm snapshot per tenant, adapter and repository.
-- CreateTable
CREATE TABLE "WarmSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "repositoryUrl" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "configSha" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarmSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WarmSnapshot_tenantId_adapter_repositoryUrl_key" ON "WarmSnapshot"("tenantId", "adapter", "repositoryUrl");

-- AddForeignKey
ALTER TABLE "WarmSnapshot" ADD CONSTRAINT "WarmSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
