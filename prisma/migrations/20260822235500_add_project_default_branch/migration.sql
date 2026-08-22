-- A Linear delegation needs a ref for the primary repository clone. SDD section 15 and section
-- 57 place the autonomy level and other human decisions on the Project record, not in the
-- repository file, so the default branch lives here too.
-- The column carries a default, so it applies to a table that already holds rows.
ALTER TABLE "Project" ADD COLUMN "defaultBranch" TEXT NOT NULL DEFAULT 'main';
