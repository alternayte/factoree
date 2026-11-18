-- docs/specs/change-sets.md, slice 8, DI-21.155. The last factoree/change-set commit status that
-- Factoree set on a consumer pull request, so an unchanged status is not set again.

-- AlterTable
ALTER TABLE "pull_request" ADD COLUMN     "change_set_status_key" TEXT;
