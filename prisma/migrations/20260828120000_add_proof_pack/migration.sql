-- SDD section 47 and section 68. The Run records the Proof Pack it posted, so the completion
-- invariant clause "Proof Pack exists" is provable from durable state.

ALTER TABLE "Run" ADD COLUMN "proofPackSha256" TEXT;
ALTER TABLE "Run" ADD COLUMN "proofPackPostedAt" TIMESTAMP(3);
