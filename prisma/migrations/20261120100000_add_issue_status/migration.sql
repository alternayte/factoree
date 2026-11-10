-- docs/specs/egress-honesty-and-issue-status.md. The Linear state a run moved its issue from and
-- the state it set, and the number and state of each pull request of a run target.
ALTER TABLE "Run" ADD COLUMN "issue_state_from_id" TEXT;
ALTER TABLE "Run" ADD COLUMN "issue_state_set_id" TEXT;
ALTER TABLE "RunTarget" ADD COLUMN "pull_request_number" INTEGER;
ALTER TABLE "RunTarget" ADD COLUMN "pull_request_state" TEXT;
-- A pull request opened before this release is open until its pull_request event says otherwise.
UPDATE "RunTarget"
SET "pull_request_number" = CAST(substring("pullRequestUrl" from '/pull/([0-9]+)') AS INTEGER),
    "pull_request_state" = 'open'
WHERE "pullRequestUrl" ~ '/pull/[0-9]+';
CREATE INDEX "RunTarget_tenantId_pull_request_number_idx" ON "RunTarget"("tenantId", "pull_request_number");
