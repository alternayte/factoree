-- docs/specs/setup-speed-and-history.md
ALTER TABLE "repository_setup" ADD COLUMN "input_key" TEXT;
ALTER TABLE "repository_setup" ADD COLUMN "skipped_from_setup_id" TEXT;
ALTER TABLE "repository_setup" ADD COLUMN "temporal_run_id" TEXT;
ALTER TABLE "repository_setup" ADD COLUMN "proof_ms" INTEGER;
ALTER TABLE "repository_setup" ADD COLUMN "warm" BOOLEAN;
ALTER TABLE "setup_app_change_issue" ADD COLUMN "linear_issue_url" TEXT;
