-- docs/specs/s3-object-store.md. Stored artifacts, the evidence store choice, the object store test and evidence retention.
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "evidence_retention_days" INTEGER;

-- AlterTable
ALTER TABLE "InstallSettings" ADD COLUMN     "evidence_storage" TEXT NOT NULL DEFAULT 'linear',
ADD COLUMN     "object_store_tested_sha256" TEXT;

-- CreateTable
CREATE TABLE "stored_artifact" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_artifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stored_artifact_run_id_idx" ON "stored_artifact"("run_id");

-- CreateIndex
CREATE INDEX "stored_artifact_tenant_id_kind_created_at_idx" ON "stored_artifact"("tenant_id", "kind", "created_at");

-- AddForeignKey
ALTER TABLE "stored_artifact" ADD CONSTRAINT "stored_artifact_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

