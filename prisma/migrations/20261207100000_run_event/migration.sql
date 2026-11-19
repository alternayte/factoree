-- docs/specs/run-diagnostics.md. One fault or one Factoree decision of a run or a setup run, in
-- order, so a user or an agent with an API key finds the cause of a failure.

-- CreateTable
CREATE TABLE "run_event" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT,
    "setup_id" TEXT,
    "stage" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "role" TEXT,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_event_pkey" PRIMARY KEY ("id"),
    -- An event belongs to exactly one run or one setup run.
    CONSTRAINT "run_event_one_subject" CHECK (("run_id" IS NULL) <> ("setup_id" IS NULL))
);

-- CreateIndex
CREATE UNIQUE INDEX "run_event_tenant_id_idempotency_key_key" ON "run_event"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "run_event_run_id_created_at_idx" ON "run_event"("run_id", "created_at");

-- CreateIndex
CREATE INDEX "run_event_setup_id_created_at_idx" ON "run_event"("setup_id", "created_at");

-- AddForeignKey
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_setup_id_fkey" FOREIGN KEY ("setup_id") REFERENCES "repository_setup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
