-- The column changes meaning, not only name. It held a Project id. It must hold a Product id.
-- SDD section 5 and section 7 put context sources under Product ownership, alongside secrets,
-- autonomy, risk caps, action policy, and redaction. A rename carries values the new foreign
-- key rejects. The drop is deliberate.

/*
  Warnings:

  - You are about to drop the column `projectId` on the `ContextSourceConfiguration` table. All the data in the column will be lost.
  - Added the required column `productId` to the `ContextSourceConfiguration` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "ContextSourceConfiguration" DROP CONSTRAINT "ContextSourceConfiguration_projectId_fkey";

-- DropIndex
DROP INDEX "ContextSourceConfiguration_projectId_sourceId_key";

-- AlterTable
ALTER TABLE "ContextSourceConfiguration" DROP COLUMN "projectId",
ADD COLUMN     "productId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ContextSourceConfiguration_productId_sourceId_key" ON "ContextSourceConfiguration"("productId", "sourceId");

-- AddForeignKey
ALTER TABLE "ContextSourceConfiguration" ADD CONSTRAINT "ContextSourceConfiguration_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
