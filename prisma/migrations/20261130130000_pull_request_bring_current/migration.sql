-- docs/specs/pr-review-merge-and-deploy.md, slice 4. The run ids the PR reviewer follow-up count
-- took (DI-21.114), the head of the last bring-current update that pushed nothing (DI-21.118), and
-- the Validation Plan of the last passing user validation pass of a run (D1, DI-21.116).
-- AlterTable
ALTER TABLE "pull_request" ADD COLUMN     "bring_current_head_sha" TEXT,
ADD COLUMN     "reviewer_follow_up_keys" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ValidationContract" ADD COLUMN     "passing_plan" JSONB;
