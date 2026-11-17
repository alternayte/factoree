-- docs/specs/pr-review-merge-and-deploy.md. The PR reviewer of a product, one row per published pull
-- request that its PR workflow owns, and the GitHub events that workflow took (DI-21.99, DI-21.100).
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "pr_reviewer_app_slug" TEXT,
ADD COLUMN     "pr_reviewer_check_name" TEXT;

-- CreateTable
CREATE TABLE "pull_request" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "head_branch" TEXT NOT NULL,
    "head_sha" TEXT NOT NULL,
    "base_branch" TEXT NOT NULL,
    "origin_run_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "merge_commit_sha" TEXT,
    "closed_at" TIMESTAMP(3),
    "reviewer_follow_ups" INTEGER NOT NULL DEFAULT 0,
    "contract_revision" INTEGER NOT NULL DEFAULT 1,
    "auto_merge" TEXT NOT NULL DEFAULT 'off',
    "auto_merge_reason" TEXT,
    "workflow_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pull_request_event" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "pull_request_id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "head_sha" TEXT,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pull_request_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pull_request_tenant_id_head_sha_idx" ON "pull_request"("tenant_id", "head_sha");

-- CreateIndex
CREATE INDEX "pull_request_origin_run_id_idx" ON "pull_request"("origin_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "pull_request_tenant_id_repository_id_number_key" ON "pull_request"("tenant_id", "repository_id", "number");

-- CreateIndex
CREATE INDEX "pull_request_event_tenant_id_idx" ON "pull_request_event"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "pull_request_event_pull_request_id_delivery_id_key" ON "pull_request_event"("pull_request_id", "delivery_id");

-- AddForeignKey
ALTER TABLE "pull_request" ADD CONSTRAINT "pull_request_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_request" ADD CONSTRAINT "pull_request_origin_run_id_fkey" FOREIGN KEY ("origin_run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_request_event" ADD CONSTRAINT "pull_request_event_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "pull_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

