-- SDD section 67 requires a normalized failure category on a failed Run.
ALTER TABLE "Run" ADD COLUMN "failureCategory" TEXT;

-- SDD section 55 requires the repository, the SHA, and the path of a reproducible context input.
ALTER TABLE "Run" ADD COLUMN "organizationSkillsSha" TEXT;
