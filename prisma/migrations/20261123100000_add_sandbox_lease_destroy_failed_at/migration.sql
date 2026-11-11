-- A delete at the sandbox provider that failed. The reaper deletes the sandbox again.
ALTER TABLE "SandboxLease" ADD COLUMN "destroy_failed_at" TIMESTAMP(3);

CREATE INDEX "SandboxLease_destroy_failed_at_idx" ON "SandboxLease"("destroy_failed_at");
