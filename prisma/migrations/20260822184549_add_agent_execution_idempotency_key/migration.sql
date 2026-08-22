-- AlterTable
ALTER TABLE "AgentExecution" ADD COLUMN     "idempotencyKey" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "AgentExecution_tenantId_idempotencyKey_key" ON "AgentExecution"("tenantId", "idempotencyKey");
