-- docs/specs/blocked-by-wait.md, DI-21.83. The blockers of a waiting run and the workflow input the
-- sweep starts it with. The sweep reads every waiting run by status.
ALTER TABLE "Run" ADD COLUMN "blockers" JSONB;
ALTER TABLE "Run" ADD COLUMN "waiting_start_input" JSONB;
CREATE INDEX "Run_status_idx" ON "Run"("status");
