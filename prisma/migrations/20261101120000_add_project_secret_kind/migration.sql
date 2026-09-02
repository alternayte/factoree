-- SDD section 30. The kind states what a Project secret is for. Every existing row is a test
-- secret, so the default backfills them correctly and no data migration is needed.
ALTER TABLE "ProjectSecret" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'test';
