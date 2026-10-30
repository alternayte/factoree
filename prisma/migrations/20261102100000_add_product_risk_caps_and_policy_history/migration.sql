-- docs/specs/autonomy-levels.md. The Product owns its risk caps, and each policy change leaves a row.
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "riskCaps" JSONB;

-- CreateTable
CREATE TABLE "ProductPolicyChange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPolicyChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductPolicyChange_productId_idx" ON "ProductPolicyChange"("productId");

-- CreateIndex
CREATE INDEX "ProductPolicyChange_tenantId_idx" ON "ProductPolicyChange"("tenantId");

-- AddForeignKey
ALTER TABLE "ProductPolicyChange" ADD CONSTRAINT "ProductPolicyChange_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPolicyChange" ADD CONSTRAINT "ProductPolicyChange_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

