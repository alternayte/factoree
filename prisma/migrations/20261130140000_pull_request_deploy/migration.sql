-- docs/specs/pr-review-merge-and-deploy.md, slice 5. The deploy results of a merged pull request
-- (DI-21.122), the merged pull requests a deploy can reach (DI-21.121), and the input of the last
-- proof pack of a run, which an amendment renders again (DI-21.123).
-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "proof_pack_input" JSONB;

-- CreateTable
CREATE TABLE "pull_request_deploy" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "pull_request_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "deployment_id" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "previous_sha" TEXT,
    "log_url" TEXT,
    "environment_url" TEXT,
    "resolved_at" TIMESTAMP(3),
    "follow_up_workflow_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pull_request_deploy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pull_request_tenant_id_state_closed_at_idx" ON "pull_request"("tenant_id", "state", "closed_at");

-- CreateIndex
CREATE INDEX "pull_request_deploy_tenant_id_state_idx" ON "pull_request_deploy"("tenant_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "pull_request_deploy_pull_request_id_key_key" ON "pull_request_deploy"("pull_request_id", "key");

-- AddForeignKey
ALTER TABLE "pull_request_deploy" ADD CONSTRAINT "pull_request_deploy_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "pull_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;
