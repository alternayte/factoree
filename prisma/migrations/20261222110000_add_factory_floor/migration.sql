-- docs/specs/factory-floor.md. The status history of runs and setup runs, and the session pulses.
CREATE TABLE "run_status_change" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "run_status_change_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "run_status_change_run_id_created_at_idx" ON "run_status_change"("run_id", "created_at");
CREATE INDEX "run_status_change_tenant_id_created_at_idx" ON "run_status_change"("tenant_id", "created_at");
ALTER TABLE "run_status_change" ADD CONSTRAINT "run_status_change_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "setup_status_change" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "setup_id" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "setup_status_change_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "setup_status_change_setup_id_created_at_idx" ON "setup_status_change"("setup_id", "created_at");
CREATE INDEX "setup_status_change_tenant_id_created_at_idx" ON "setup_status_change"("tenant_id", "created_at");
ALTER TABLE "setup_status_change" ADD CONSTRAINT "setup_status_change_setup_id_fkey" FOREIGN KEY ("setup_id") REFERENCES "repository_setup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "session_pulse" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT,
    "setup_id" TEXT,
    "role" TEXT NOT NULL,
    "tool_kind" TEXT NOT NULL,
    "last_output_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "session_pulse_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "session_pulse_run_id_created_at_idx" ON "session_pulse"("run_id", "created_at");
CREATE INDEX "session_pulse_setup_id_created_at_idx" ON "session_pulse"("setup_id", "created_at");
CREATE INDEX "session_pulse_tenant_id_created_at_idx" ON "session_pulse"("tenant_id", "created_at");
ALTER TABLE "session_pulse" ADD CONSTRAINT "session_pulse_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "session_pulse" ADD CONSTRAINT "session_pulse_setup_id_fkey" FOREIGN KEY ("setup_id") REFERENCES "repository_setup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A trigger records each status change in the transaction that makes it, so every writer of the
-- status column leaves a row: updateStatus, the slot grant, the adoption of a waiting run, the draft.
CREATE FUNCTION "record_run_status_change"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."status" IS DISTINCT FROM OLD."status" THEN
    INSERT INTO "run_status_change" ("id", "tenant_id", "run_id", "from_status", "to_status", "created_at")
    VALUES (gen_random_uuid()::text, NEW."tenantId", NEW."id", CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."status" END, NEW."status", clock_timestamp());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "run_status_change_trigger" AFTER INSERT OR UPDATE OF "status" ON "Run"
  FOR EACH ROW EXECUTE FUNCTION "record_run_status_change"();

CREATE FUNCTION "record_setup_status_change"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."status" IS DISTINCT FROM OLD."status" THEN
    INSERT INTO "setup_status_change" ("id", "tenant_id", "setup_id", "from_status", "to_status", "created_at")
    VALUES (gen_random_uuid()::text, NEW."tenant_id", NEW."id", CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."status" END, NEW."status", clock_timestamp());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "setup_status_change_trigger" AFTER INSERT OR UPDATE OF "status" ON "repository_setup"
  FOR EACH ROW EXECUTE FUNCTION "record_setup_status_change"();
