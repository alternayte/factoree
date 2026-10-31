-- docs/specs/proof-pack-and-visual-evidence.md. The proof-pack.json document, and the pull request preview URL.
-- AlterTable
ALTER TABLE "Run" ADD COLUMN "proofPackDocument" JSONB;

-- AlterTable
ALTER TABLE "RunTarget" ADD COLUMN "previewUrl" TEXT;

-- CreateIndex
CREATE INDEX "RunTarget_tenantId_commitSha_idx" ON "RunTarget"("tenantId", "commitSha");
