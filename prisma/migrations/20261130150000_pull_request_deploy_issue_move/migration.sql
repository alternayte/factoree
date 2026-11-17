-- docs/specs/pr-review-merge-and-deploy.md, slice 5, DI-21.126. The delivery that recorded a deploy
-- result and the issue move of a failed deploy, so a retry gives the same outcome and notice.
-- AlterTable
ALTER TABLE "pull_request_deploy" ADD COLUMN     "delivery_id" TEXT,
ADD COLUMN     "issue_move" TEXT,
ADD COLUMN     "issue_state_name" TEXT;
