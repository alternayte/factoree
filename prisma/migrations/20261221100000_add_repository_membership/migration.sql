-- docs/specs/repository-membership.md. A new claim starts pending. Every existing repository already
-- runs, and the owner controls each one, so the migration accepts it with no decider.
ALTER TABLE "Repository" ADD COLUMN "membership" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "Repository" ADD COLUMN "membership_decided_by" TEXT;
ALTER TABLE "Repository" ADD COLUMN "membership_decided_at" TIMESTAMP(3);
UPDATE "Repository" SET "membership" = 'accepted';
