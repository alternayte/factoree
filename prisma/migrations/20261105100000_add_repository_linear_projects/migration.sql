-- docs/specs/own-proposals-and-parallel-runs.md. The Linear projects a repository declares.
-- AlterTable
ALTER TABLE "Repository" ADD COLUMN "linearProjects" TEXT[] DEFAULT ARRAY[]::TEXT[];
