-- docs/specs/run-recovery.md. A follow-up run shares the agent session of the failed run, names
-- that run, and can read the last patch it captured.
DROP INDEX "Run_linearAgentSessionId_key";
CREATE INDEX "Run_linearAgentSessionId_createdAt_idx" ON "Run"("linearAgentSessionId", "createdAt");
ALTER TABLE "Run" ADD COLUMN "follow_up_of_run_id" TEXT;
ALTER TABLE "Run" ADD COLUMN "last_patch_base64" TEXT;
