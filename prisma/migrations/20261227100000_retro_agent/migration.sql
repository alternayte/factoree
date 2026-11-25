-- docs/specs/retro-agent.md. Retro settings, retros, retro sessions, findings, signal sources and
-- results, kept transcripts, the product goal, and the follow-up reply of a run.

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "follow_up_reply" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "keep_transcripts" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "product_goal" TEXT,
ADD COLUMN     "retro_retention_days" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "InstallSettings" ADD COLUMN     "transcript_s3_access_key" TEXT,
ADD COLUMN     "transcript_s3_bucket" TEXT,
ADD COLUMN     "transcript_s3_endpoint" TEXT,
ADD COLUMN     "transcript_s3_region" TEXT,
ADD COLUMN     "transcript_s3_secret_key_cipher" TEXT;

-- AlterTable
ALTER TABLE "session_pulse" ADD COLUMN     "product_id" TEXT,
ADD COLUMN     "retro_id" TEXT;

-- CreateTable
CREATE TABLE "retro_settings" (
    "tenant_id" TEXT NOT NULL,
    "schedule" TEXT NOT NULL DEFAULT 'off',
    "weekday" INTEGER NOT NULL DEFAULT 1,
    "hour" INTEGER NOT NULL DEFAULT 9,
    "time_zone" TEXT NOT NULL DEFAULT 'UTC',
    "product_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "runner" TEXT,
    "model" TEXT,
    "effort" TEXT,
    "cost_cap_usd" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retro_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "retro" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "window_start" TIMESTAMP(3),
    "window_end" TIMESTAMP(3) NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "product_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cost_usd" DOUBLE PRECISION,
    "finding_count" INTEGER NOT NULL DEFAULT 0,
    "failure_message" TEXT,
    "events" JSONB NOT NULL DEFAULT '[]',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "retro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retro_session" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "retro_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "runner" TEXT,
    "model" TEXT,
    "effort" TEXT,
    "outcome" TEXT,
    "cost_usd" DOUBLE PRECISION,
    "duration_ms" INTEGER,
    "metrics" JSONB,
    "failure_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retro_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retro_finding" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "retro_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "run_ids" TEXT[],
    "signal_result_ids" TEXT[],
    "repositories" TEXT[],
    "status" TEXT NOT NULL,
    "duplicate_of_id" TEXT,
    "linear_issue_id" TEXT,
    "linear_issue_identifier" TEXT,
    "linear_issue_url" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retro_finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_source" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "secret_name" TEXT,
    "queries" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signal_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_result" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "retro_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "source_name" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "query_name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_transcript" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "gzip" BYTEA,
    "object_key" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_transcript_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "retro_workflow_id_key" ON "retro"("workflow_id");

-- CreateIndex
CREATE INDEX "retro_tenant_id_started_at_idx" ON "retro"("tenant_id", "started_at");

-- CreateIndex
CREATE INDEX "retro_tenant_id_status_idx" ON "retro"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "retro_session_retro_id_product_id_key" ON "retro_session"("retro_id", "product_id");

-- CreateIndex
CREATE INDEX "retro_finding_retro_id_idx" ON "retro_finding"("retro_id");

-- CreateIndex
CREATE INDEX "retro_finding_product_id_status_idx" ON "retro_finding"("product_id", "status");

-- CreateIndex
CREATE INDEX "signal_source_tenant_id_idx" ON "signal_source"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "signal_source_product_id_name_key" ON "signal_source"("product_id", "name");

-- CreateIndex
CREATE INDEX "signal_result_retro_id_idx" ON "signal_result"("retro_id");

-- CreateIndex
CREATE INDEX "signal_result_product_id_created_at_idx" ON "signal_result"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_transcript_run_id_idx" ON "agent_transcript"("run_id");

-- CreateIndex
CREATE INDEX "agent_transcript_product_id_created_at_idx" ON "agent_transcript"("product_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_transcript_tenant_id_idempotency_key_key" ON "agent_transcript"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "session_pulse_retro_id_created_at_idx" ON "session_pulse"("retro_id", "created_at");

-- AddForeignKey
ALTER TABLE "session_pulse" ADD CONSTRAINT "session_pulse_retro_id_fkey" FOREIGN KEY ("retro_id") REFERENCES "retro"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retro_settings" ADD CONSTRAINT "retro_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retro" ADD CONSTRAINT "retro_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retro_session" ADD CONSTRAINT "retro_session_retro_id_fkey" FOREIGN KEY ("retro_id") REFERENCES "retro"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retro_session" ADD CONSTRAINT "retro_session_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retro_finding" ADD CONSTRAINT "retro_finding_retro_id_fkey" FOREIGN KEY ("retro_id") REFERENCES "retro"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retro_finding" ADD CONSTRAINT "retro_finding_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_source" ADD CONSTRAINT "signal_source_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_result" ADD CONSTRAINT "signal_result_retro_id_fkey" FOREIGN KEY ("retro_id") REFERENCES "retro"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_result" ADD CONSTRAINT "signal_result_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_transcript" ADD CONSTRAINT "agent_transcript_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_transcript" ADD CONSTRAINT "agent_transcript_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

