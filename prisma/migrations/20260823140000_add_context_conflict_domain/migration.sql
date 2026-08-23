-- SDD section 22 makes authority conflicts domain-specific. A recorded human answer settles one
-- subject in one authority domain, so the conflict record must name the domain.
-- The ContextConflict table arrived in the previous migration of this phase, and no released
-- database holds a row of it. The column is therefore added NOT NULL with no backfill.

ALTER TABLE "ContextConflict" ADD COLUMN "authorityDomain" TEXT NOT NULL;
