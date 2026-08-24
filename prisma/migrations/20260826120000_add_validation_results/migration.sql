-- SDD section 39 and section 53. One persisted result per validation assertion and per attempt,
-- and the foreign key from Evidence to the validation assertion it answers.

CREATE TABLE "ValidationAssertionResult" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "validationAssertionId" TEXT NOT NULL,
    "assertionKey" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationAssertionResult_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ValidationAssertionResult_runId_validationAssertionId_attem_key"
    ON "ValidationAssertionResult"("runId", "validationAssertionId", "attempt");
CREATE INDEX "ValidationAssertionResult_tenantId_runId_idx"
    ON "ValidationAssertionResult"("tenantId", "runId");

ALTER TABLE "ValidationAssertionResult"
    ADD CONSTRAINT "ValidationAssertionResult_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ValidationAssertionResult"
    ADD CONSTRAINT "ValidationAssertionResult_validationAssertionId_fkey"
    FOREIGN KEY ("validationAssertionId") REFERENCES "ValidationAssertion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The column already exists and every existing row holds NULL, which satisfies this constraint.
ALTER TABLE "Evidence"
    ADD CONSTRAINT "Evidence_validationAssertionId_fkey"
    FOREIGN KEY ("validationAssertionId") REFERENCES "ValidationAssertion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
