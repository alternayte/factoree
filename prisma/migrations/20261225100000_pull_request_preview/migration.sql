-- docs/specs/pr-body-for-humans.md, DI-21.220.
ALTER TABLE "pull_request" ADD COLUMN "preview_url" TEXT;
ALTER TABLE "pull_request" ADD COLUMN "preview_head_sha" TEXT;
