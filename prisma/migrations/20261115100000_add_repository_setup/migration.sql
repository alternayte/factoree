-- docs/specs/repository-setup-and-services.md. A setup run writes and proves the configuration of a
-- repository. A failed build-ahead marks a repository for setup. The setup role has its own effort.
ALTER TABLE "Product" ADD COLUMN "effort_setup" TEXT;
ALTER TABLE "Repository" ADD COLUMN "needs_setup_reason" TEXT;
ALTER TABLE "Repository" ADD COLUMN "needs_setup_at" TIMESTAMP(3);

CREATE TABLE "repository_setup" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "repository_full_name" TEXT NOT NULL,
    "github_installation_id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "pull_request_url" TEXT,
    "report" JSONB,
    "failure_message" TEXT,
    "session_usage" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    CONSTRAINT "repository_setup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "repository_setup_product_id_repository_full_name_created_at_idx" ON "repository_setup"("product_id", "repository_full_name", "created_at");

ALTER TABLE "repository_setup" ADD CONSTRAINT "repository_setup_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
