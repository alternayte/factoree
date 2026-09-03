/*
  Warnings:

  - You are about to drop the column `projectId` on the `Run` table. All the data in the column will be lost.
  - Added the required column `productId` to the `Run` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "Run_projectId_idx";

-- AlterTable
ALTER TABLE "Run" DROP COLUMN "projectId",
ADD COLUMN     "productId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "Run_productId_idx" ON "Run"("productId");

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
