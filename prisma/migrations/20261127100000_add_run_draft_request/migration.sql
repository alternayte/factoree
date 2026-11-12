-- docs/specs/draft-of-failed-run.md, DI-21.76 and DI-21.79. The attempt of the last patch, and who
-- asked for the draft of a failed run and from where.
ALTER TABLE "Run" ADD COLUMN "last_patch_attempt" INTEGER;
ALTER TABLE "Run" ADD COLUMN "draft_requested_at" TIMESTAMP(3);
ALTER TABLE "Run" ADD COLUMN "draft_source" TEXT;
ALTER TABLE "Run" ADD COLUMN "draft_requested_by" TEXT;
