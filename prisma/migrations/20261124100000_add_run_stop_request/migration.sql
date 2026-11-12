-- Issue #45, DI-21.65. Who stopped a run and from where.
ALTER TABLE "Run" ADD COLUMN "stop_requested_at" TIMESTAMP(3);
ALTER TABLE "Run" ADD COLUMN "stop_source" TEXT;
ALTER TABLE "Run" ADD COLUMN "stop_requested_by" TEXT;
