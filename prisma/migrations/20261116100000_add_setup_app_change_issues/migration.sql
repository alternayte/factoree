-- docs/specs/setup-app-change-issues.md. A merged setup creates and delegates a Linear issue for its
-- app changes. Factoree stores each one to dedupe, and starts one follow-up setup per round.
ALTER TABLE "Product" ADD COLUMN "app_change_issues" TEXT NOT NULL DEFAULT 'one_per_change';
ALTER TABLE "repository_setup" ADD COLUMN "follow_up_setup_id" TEXT;

CREATE TABLE "setup_app_change_issue" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "setup_id" TEXT NOT NULL,
    "repository_full_name" TEXT NOT NULL,
    "changes" TEXT[],
    "linear_issue_id" TEXT NOT NULL,
    "linear_issue_identifier" TEXT NOT NULL,
    "outcome" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    CONSTRAINT "setup_app_change_issue_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "setup_app_change_issue_tenant_id_repository_full_name_idx" ON "setup_app_change_issue"("tenant_id", "repository_full_name");

ALTER TABLE "setup_app_change_issue" ADD CONSTRAINT "setup_app_change_issue_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "setup_app_change_issue" ADD CONSTRAINT "setup_app_change_issue_setup_id_fkey" FOREIGN KEY ("setup_id") REFERENCES "repository_setup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
