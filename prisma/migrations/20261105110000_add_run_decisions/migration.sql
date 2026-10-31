-- docs/specs/own-proposals-and-parallel-runs.md. Every proposal Factoree took without asking.
-- AlterTable
ALTER TABLE "Run" ADD COLUMN "decisions" JSONB NOT NULL DEFAULT '[]';
