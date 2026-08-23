-- SDD section 53. The ContextContract, ContextItem, and ContextConflict entities.
-- Every table is new, so this migration is safe against a populated database.

CREATE TABLE "ContextContract" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextContract_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContextContract_runId_key" ON "ContextContract"("runId");
CREATE INDEX "ContextContract_tenantId_idx" ON "ContextContract"("tenantId");

ALTER TABLE "ContextContract" ADD CONSTRAINT "ContextContract_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ContextItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contextContractId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "repository" TEXT,
    "sha" TEXT,
    "path" TEXT,
    "sourceVersion" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contentSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContextItem_contextContractId_ref_key" ON "ContextItem"("contextContractId", "ref");
CREATE INDEX "ContextItem_tenantId_idx" ON "ContextItem"("tenantId");

ALTER TABLE "ContextItem" ADD CONSTRAINT "ContextItem_contextContractId_fkey"
    FOREIGN KEY ("contextContractId") REFERENCES "ContextContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ContextConflict" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contextContractId" TEXT NOT NULL,
    "conflictKey" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "winnerRef" TEXT,
    "loserRef" TEXT,
    "reason" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextConflict_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContextConflict_contextContractId_conflictKey_key" ON "ContextConflict"("contextContractId", "conflictKey");
CREATE INDEX "ContextConflict_tenantId_idx" ON "ContextConflict"("tenantId");

ALTER TABLE "ContextConflict" ADD CONSTRAINT "ContextConflict_contextContractId_fkey"
    FOREIGN KEY ("contextContractId") REFERENCES "ContextContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
