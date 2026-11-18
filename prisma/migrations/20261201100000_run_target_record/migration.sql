-- docs/specs/change-sets.md, DI-21.127. One record per target: the base SHA, the config SHA, the patch
-- hash, the commit, the pull request, the merge order and the last patch move from the run to its
-- run targets, and the provider-to-consumer edges of a change set get their own table.

-- AlterTable
ALTER TABLE "RunTarget" ADD COLUMN     "config_sha" TEXT,
ADD COLUMN     "last_patch_attempt" INTEGER,
ADD COLUMN     "last_patch_base64" TEXT,
ADD COLUMN     "merge_order" INTEGER;

-- A run from before run targets existed has no target. Its pull request names the repository, so
-- the run gets the target of the tenant's repository of that name. A run with no pull request, or
-- whose repository is gone, keeps no target, and its run facts go with the columns below.
INSERT INTO "RunTarget" ("id", "tenantId", "runId", "repositoryId", "selectionReason", "createdAt")
SELECT gen_random_uuid()::text, r."tenantId", r."id", repo."id", 'the repository of ' || r."pullRequestUrl", r."createdAt"
FROM "Run" r
JOIN "Repository" repo
  ON repo."tenantId" = r."tenantId"
 AND lower(repo."fullName") = lower(substring(r."pullRequestUrl" from '^https://[^/]+/([^/]+/[^/]+)/pull/[0-9]+'))
WHERE r."pullRequestUrl" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "RunTarget" t WHERE t."runId" = r."id");

-- Every run so far has at most one target, so the run facts are the facts of that target. A fact the
-- target recorded itself wins.
UPDATE "RunTarget" t
SET "baseSha" = COALESCE(t."baseSha", r."baseSha"),
    "config_sha" = r."configSha",
    "patchSha256" = COALESCE(t."patchSha256", r."patchSha256"),
    "commitSha" = COALESCE(t."commitSha", r."commitSha"),
    "pullRequestUrl" = COALESCE(t."pullRequestUrl", r."pullRequestUrl"),
    "last_patch_base64" = r."last_patch_base64",
    "last_patch_attempt" = r."last_patch_attempt"
FROM "Run" r
WHERE t."runId" = r."id"
  AND (SELECT count(*) FROM "RunTarget" o WHERE o."runId" = r."id") = 1;

-- A pull request the update gave a target is open until its pull_request event says otherwise, as
-- in 20261120100000_add_issue_status.
UPDATE "RunTarget"
SET "pull_request_number" = CAST(substring("pullRequestUrl" from '/pull/([0-9]+)') AS INTEGER),
    "pull_request_state" = 'open'
WHERE "pull_request_number" IS NULL
  AND "pullRequestUrl" ~ '/pull/[0-9]+';

-- docs/specs/blocked-by-wait.md. A stored blocker names the pull requests of its newest run as a list,
-- so a sweep compares the stored blockers with the blockers it reads in the same shape.
UPDATE "Run"
SET "blockers" = (
  SELECT jsonb_agg(
           (e.elem - 'pullRequestUrl') || jsonb_build_object(
             'pullRequestUrls',
             CASE WHEN jsonb_typeof(e.elem -> 'pullRequestUrl') = 'string'
                  THEN jsonb_build_array(e.elem -> 'pullRequestUrl')
                  ELSE '[]'::jsonb END)
           ORDER BY e.ord)
  FROM jsonb_array_elements("Run"."blockers") WITH ORDINALITY AS e(elem, ord)
)
WHERE jsonb_typeof("blockers") = 'array' AND jsonb_array_length("blockers") > 0;

-- AlterTable
ALTER TABLE "Run" DROP COLUMN "baseSha",
DROP COLUMN "commitSha",
DROP COLUMN "configSha",
DROP COLUMN "last_patch_attempt",
DROP COLUMN "last_patch_base64",
DROP COLUMN "patchSha256",
DROP COLUMN "pullRequestUrl";

-- CreateTable
CREATE TABLE "run_target_edge" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "provider_target_id" TEXT NOT NULL,
    "consumer_target_id" TEXT NOT NULL,
    "citation_file" TEXT NOT NULL,
    "citation_line" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_target_edge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "run_target_edge_run_id_idx" ON "run_target_edge"("run_id");

-- CreateIndex
CREATE INDEX "run_target_edge_tenant_id_idx" ON "run_target_edge"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "run_target_edge_provider_target_id_consumer_target_id_key" ON "run_target_edge"("provider_target_id", "consumer_target_id");

-- AddForeignKey
ALTER TABLE "run_target_edge" ADD CONSTRAINT "run_target_edge_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_target_edge" ADD CONSTRAINT "run_target_edge_provider_target_id_fkey" FOREIGN KEY ("provider_target_id") REFERENCES "RunTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_target_edge" ADD CONSTRAINT "run_target_edge_consumer_target_id_fkey" FOREIGN KEY ("consumer_target_id") REFERENCES "RunTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
