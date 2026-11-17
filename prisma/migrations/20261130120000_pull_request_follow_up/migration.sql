-- docs/specs/pr-review-merge-and-deploy.md, slice 3. The verified base and the run of the verified
-- head, which a PR follow-up run starts from (D2), and the PR reviewer check that last started a
-- triage, so one check starts one triage (DI-21.108).
-- AlterTable
ALTER TABLE "pull_request" ADD COLUMN     "reviewer_handled_key" TEXT,
ADD COLUMN     "verified_base_sha" TEXT,
ADD COLUMN     "verified_run_id" TEXT;
