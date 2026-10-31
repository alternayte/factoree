-- docs/specs/agent-session-usage-and-hangs.md. One row per agent session, with its usage and outcome.
-- CreateTable
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "runner" TEXT NOT NULL,
    "cli_session_id" TEXT,
    "model" TEXT,
    "effort" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "reasoning_tokens" INTEGER,
    "cache_read_tokens" INTEGER,
    "cache_write_tokens" INTEGER,
    "cost_usd" DOUBLE PRECISION,
    "turns" INTEGER,
    "duration_ms" INTEGER NOT NULL,
    "longest_turn_ms" INTEGER,
    "outcome" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentSession_tenant_id_idx" ON "AgentSession"("tenant_id");

-- CreateIndex
CREATE INDEX "AgentSession_run_id_idx" ON "AgentSession"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSession_tenant_id_idempotency_key_key" ON "AgentSession"("tenant_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

