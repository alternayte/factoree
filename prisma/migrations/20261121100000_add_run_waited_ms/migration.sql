-- DI-21.56. The time a run waited for a run slot or a sandbox slot.
ALTER TABLE "Run" ADD COLUMN "waited_ms" INTEGER NOT NULL DEFAULT 0;
