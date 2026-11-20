-- docs/specs/private-stack-onboarding.md. The derived hosts of a setup and the time of its warm proof.
ALTER TABLE "repository_setup" ADD COLUMN "derived_hosts" JSONB;
ALTER TABLE "repository_setup" ADD COLUMN "warm_proof_ms" INTEGER;
