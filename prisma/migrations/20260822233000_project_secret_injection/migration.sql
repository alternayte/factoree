-- Only a Project secret an operator marks reaches the Implementer environment. SDD section 30.
-- The default keeps the column appliable to a populated table, and it denies injection of every
-- secret that exists today.
ALTER TABLE "ProjectSecret" ADD COLUMN "injectIntoImplementer" BOOLEAN NOT NULL DEFAULT false;
