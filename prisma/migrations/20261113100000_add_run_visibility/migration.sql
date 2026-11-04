-- docs/specs/run-visibility.md. The failure message and the work item of each run.
ALTER TABLE "Run" ADD COLUMN "failure_message" TEXT;
ALTER TABLE "Run" ADD COLUMN "work_item_title" TEXT;
ALTER TABLE "Run" ADD COLUMN "work_item_url" TEXT;
