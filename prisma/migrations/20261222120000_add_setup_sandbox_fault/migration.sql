-- docs/specs/sandbox-memory-and-size.md. The sandbox fault of the run that started a setup.
ALTER TABLE "repository_setup" ADD COLUMN "sandbox_fault" TEXT;
