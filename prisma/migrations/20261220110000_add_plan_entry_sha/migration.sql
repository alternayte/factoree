-- docs/specs/check-faults.md. The plan entry each assertion result ran with.
ALTER TABLE "ValidationAssertionResult" ADD COLUMN "planEntrySha256" TEXT;
