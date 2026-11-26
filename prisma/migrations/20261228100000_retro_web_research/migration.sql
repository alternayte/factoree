-- docs/specs/retro-web-research.md. The retro gateway sessions, web results, ticked tools, live signal
-- calls, the Web research switch and the Exa key.

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "web_research" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "InstallSettings" ADD COLUMN     "exa_api_key_cipher" TEXT;

-- AlterTable
ALTER TABLE "retro_finding" ADD COLUMN     "web_result_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "signal_source" ADD COLUMN     "ticked_tools" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "signal_result" ADD COLUMN     "arguments" JSONB,
ADD COLUMN     "gateway_session_id" TEXT,
ADD COLUMN     "live" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "retro_gateway_session" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "retro_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "token_sha256" TEXT NOT NULL,
    "web_research" BOOLEAN NOT NULL,
    "cost_left_usd" DOUBLE PRECISION NOT NULL,
    "spent_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "searches" INTEGER NOT NULL DEFAULT 0,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "signal_calls" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retro_gateway_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "web_result" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "retro_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "gateway_session_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "query" TEXT,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "published_date" TEXT,
    "content" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "web_result_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "retro_gateway_session_token_sha256_key" ON "retro_gateway_session"("token_sha256");

-- CreateIndex
CREATE INDEX "retro_gateway_session_retro_id_idx" ON "retro_gateway_session"("retro_id");

-- CreateIndex
CREATE INDEX "web_result_gateway_session_id_url_idx" ON "web_result"("gateway_session_id", "url");

-- CreateIndex
CREATE INDEX "web_result_retro_id_idx" ON "web_result"("retro_id");

-- CreateIndex
CREATE INDEX "web_result_product_id_created_at_idx" ON "web_result"("product_id", "created_at");

-- AddForeignKey
ALTER TABLE "retro_gateway_session" ADD CONSTRAINT "retro_gateway_session_retro_id_fkey" FOREIGN KEY ("retro_id") REFERENCES "retro"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retro_gateway_session" ADD CONSTRAINT "retro_gateway_session_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_result" ADD CONSTRAINT "web_result_retro_id_fkey" FOREIGN KEY ("retro_id") REFERENCES "retro"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_result" ADD CONSTRAINT "web_result_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_result" ADD CONSTRAINT "web_result_gateway_session_id_fkey" FOREIGN KEY ("gateway_session_id") REFERENCES "retro_gateway_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

