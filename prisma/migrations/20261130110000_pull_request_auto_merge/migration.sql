-- docs/specs/pr-review-merge-and-deploy.md. The verified head, the level of the run that published
-- it, and the base branch of the L4 gate Factoree read (DI-21.104, DI-21.106).
-- AlterTable
ALTER TABLE "pull_request" ADD COLUMN     "auto_merge_gate_base" TEXT,
ADD COLUMN     "autonomy_level" TEXT,
ADD COLUMN     "verified_head_sha" TEXT;
