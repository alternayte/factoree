-- docs/specs/multi-repo-tenancy.md. Change Sets are Version 2, so a RunTarget needs no role and no merge order.
-- AlterTable
ALTER TABLE "RunTarget" DROP COLUMN "mergeOrder",
DROP COLUMN "role";

