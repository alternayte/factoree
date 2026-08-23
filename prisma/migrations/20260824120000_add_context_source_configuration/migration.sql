-- SDD section 53. One row per configured Backstage catalog or MCP server of one Project.
-- The table is new, so no row can exist and no backfill is needed.
CREATE TABLE "ContextSourceConfiguration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "endpoint" TEXT NOT NULL,
    "secretName" TEXT,
    "settings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextSourceConfiguration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContextSourceConfiguration_projectId_sourceId_key"
    ON "ContextSourceConfiguration"("projectId", "sourceId");

CREATE INDEX "ContextSourceConfiguration_tenantId_idx"
    ON "ContextSourceConfiguration"("tenantId");

ALTER TABLE "ContextSourceConfiguration"
    ADD CONSTRAINT "ContextSourceConfiguration_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
