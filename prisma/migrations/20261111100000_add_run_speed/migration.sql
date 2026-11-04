-- docs/specs/run-speed.md. The stage timings of each run, the model and tool time of each agent
-- session, and the bootstrap key of each warm snapshot in place of its configuration SHA.

-- CreateTable
CREATE TABLE "run_stage" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "sandbox_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_stage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "run_stage_run_id_idx" ON "run_stage"("run_id");

-- AddForeignKey
ALTER TABLE "run_stage" ADD CONSTRAINT "run_stage_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "AgentSession" ADD COLUMN "model_ms" INTEGER,
ADD COLUMN "tool_ms" INTEGER;

-- AlterTable. A configuration SHA is no bootstrap key, so an existing row matches no run, and the
-- next run or build-ahead replaces it.
ALTER TABLE "WarmSnapshot" RENAME COLUMN "configSha" TO "bootstrapKey";
ALTER TABLE "WarmSnapshot" ADD COLUMN "warmCommandExitCode" INTEGER;
