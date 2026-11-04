-- docs/specs/skill-registry.md
ALTER TABLE "Product" ADD COLUMN "skill_registry_kind" TEXT;
ALTER TABLE "Product" ADD COLUMN "skill_registry_url" TEXT;
ALTER TABLE "Product" ADD COLUMN "skill_registry_set" TEXT;

ALTER TABLE "Run" ADD COLUMN "skill_registry_set" TEXT;
ALTER TABLE "Run" ADD COLUMN "skill_resolution_id" TEXT;

CREATE TABLE "run_skill" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "version" INTEGER,
    "sha256" TEXT,
    "listed" BOOLEAN NOT NULL,
    "activated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "run_skill_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "run_skill_run_id_path_key" ON "run_skill"("run_id", "path");

ALTER TABLE "run_skill" ADD CONSTRAINT "run_skill_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "run_skill_proposal" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reference" TEXT,
    "url" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_skill_proposal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "run_skill_proposal_run_id_name_source_key" ON "run_skill_proposal"("run_id", "name", "source");

ALTER TABLE "run_skill_proposal" ADD CONSTRAINT "run_skill_proposal_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
