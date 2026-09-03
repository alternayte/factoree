/*
  Warnings:

  - Added the required column `tenantId` to the `RunTarget` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "RunTarget" ADD COLUMN     "tenantId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "RunTarget_tenantId_idx" ON "RunTarget"("tenantId");
