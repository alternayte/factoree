-- docs/specs/pr-feedback-loop.md. Factoree detects review apps, so the product names none. A deny
-- list mutes a review app, and one limit counts the PR follow-up runs of review apps and CI checks.
ALTER TABLE "Product" DROP COLUMN "pr_reviewer_app_slug";
ALTER TABLE "Product" DROP COLUMN "pr_reviewer_check_name";
ALTER TABLE "Product" ADD COLUMN "review_app_deny_list" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Product" ADD COLUMN "automatic_follow_up_limit" INTEGER NOT NULL DEFAULT 3;
