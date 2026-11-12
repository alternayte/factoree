-- Issue #43, DI-21.67. The repair budget of a run whose repository sets no repair.maxAttempts.
ALTER TABLE "Product" ADD COLUMN "repair_max_attempts" INTEGER NOT NULL DEFAULT 2;
