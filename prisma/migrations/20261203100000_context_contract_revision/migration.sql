-- docs/specs/change-sets.md, DI-21.143. A target the refiner adds freezes a new Context Contract of
-- the run. Each contract keeps its row, numbered by its revision. Every existing contract is the
-- first revision of its run.

-- DropIndex
DROP INDEX "ContextContract_runId_key";

-- AlterTable
ALTER TABLE "ContextContract" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "ContextContract_runId_revision_key" ON "ContextContract"("runId", "revision");
