-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "spriteAdapter" TEXT,
ADD COLUMN     "spriteRetainUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Run_spriteRetainUntil_idx" ON "Run"("spriteRetainUntil");

