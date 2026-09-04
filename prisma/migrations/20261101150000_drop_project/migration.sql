-- Task 12. Product and Repository replaced Project everywhere a caller could reach it: routing,
-- discovery, the workflow, the secret store, and the administration API. Task 11 re-parented
-- ContextSourceConfiguration onto Product. No table still references Project, so the drop is
-- deliberate: it removes the guessing lookups this table made possible, not only unused code.

/*
  Warnings:

  - You are about to drop the `Project` table. If the table is not empty, all the data in it will be lost.
  - You are about to drop the `ProjectSecret` table. If the table is not empty, all the data in it will be lost.

*/
-- DropForeignKey
ALTER TABLE "Project" DROP CONSTRAINT "Project_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ProjectSecret" DROP CONSTRAINT "ProjectSecret_projectId_fkey";

-- DropTable
DROP TABLE "ProjectSecret";

-- DropTable
DROP TABLE "Project";
