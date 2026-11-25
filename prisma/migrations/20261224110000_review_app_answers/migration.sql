-- docs/specs/pr-feedback-loop.md, DI-21.212 and DI-21.214.
ALTER TABLE "pull_request" ADD COLUMN "answered_finding_fingerprints" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "pull_request" ADD COLUMN "review_app_notice_key" TEXT;
