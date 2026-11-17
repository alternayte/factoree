-- docs/specs/change-sets.md, DI-21.135. A warm snapshot can hold a set. Its row names the sorted
-- repository URLs of the set. A snapshot of one repository keeps its row and an empty list.

-- AlterTable
ALTER TABLE "WarmSnapshot" ADD COLUMN     "repository_urls" TEXT[] DEFAULT ARRAY[]::TEXT[];
