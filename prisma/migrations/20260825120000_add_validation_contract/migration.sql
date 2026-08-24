-- SDD section 53. The frozen Validation Contract of one Run, and its assertions.
CREATE TABLE "ValidationContract" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "workItem" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationContract_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ValidationContract_runId_key" ON "ValidationContract"("runId");
CREATE INDEX "ValidationContract_tenantId_idx" ON "ValidationContract"("tenantId");

ALTER TABLE "ValidationContract"
    ADD CONSTRAINT "ValidationContract_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ValidationAssertion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "validationContractId" TEXT NOT NULL,
    "assertionKey" TEXT NOT NULL,
    "requirement" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "evidence" TEXT[],
    "preconditions" TEXT[],

    CONSTRAINT "ValidationAssertion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ValidationAssertion_validationContractId_assertionKey_key"
    ON "ValidationAssertion"("validationContractId", "assertionKey");
CREATE INDEX "ValidationAssertion_tenantId_idx" ON "ValidationAssertion"("tenantId");

ALTER TABLE "ValidationAssertion"
    ADD CONSTRAINT "ValidationAssertion_validationContractId_fkey"
    FOREIGN KEY ("validationContractId") REFERENCES "ValidationContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
