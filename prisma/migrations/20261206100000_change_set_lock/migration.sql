-- docs/specs/change-sets.md, slice 9, DI-21.158. One set run at a time across the PR workflows of a
-- change set: the run that opened the set holds the PR workflow and the run that hold the set.

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "change_set_lock_at" TIMESTAMP(3),
ADD COLUMN     "change_set_lock_holder" TEXT,
ADD COLUMN     "change_set_lock_run" TEXT;
