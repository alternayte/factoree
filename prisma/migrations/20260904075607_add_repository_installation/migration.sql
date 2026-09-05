-- The column carries the installation that granted access to the repository. Discovery did
-- not record it before this migration, so an existing row carries no value to backfill.
-- The product is not in production, so the row is removed rather than backfilled.
--
-- A `RunTarget` row references a `Repository` row through a `Restrict` foreign key, so a
-- deletion of the `Repository` row fails while a `RunTarget` row still points at it. Those
-- dependent rows carry no value either, for the identical reason, so this migration removes
-- them first.

/*
  Warnings:

  - Added the required column `githubInstallationId` to the `Repository` table without a default value. This is not possible if the table is not empty.

*/
-- DeleteRows
DELETE FROM "RunTarget";
DELETE FROM "Repository";

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "githubInstallationId" TEXT NOT NULL;
