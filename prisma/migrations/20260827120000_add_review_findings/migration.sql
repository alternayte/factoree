-- SDD section 53. One immutable review finding row per finding per attempt.

CREATE TABLE "ReviewFinding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "verdict" TEXT NOT NULL,
    "findingKey" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "requirement" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL,
    "decisionReason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewFinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReviewFinding_runId_attempt_findingKey_key" ON "ReviewFinding"("runId", "attempt", "findingKey");
CREATE INDEX "ReviewFinding_tenantId_runId_idx" ON "ReviewFinding"("tenantId", "runId");

ALTER TABLE "ReviewFinding"
    ADD CONSTRAINT "ReviewFinding_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
