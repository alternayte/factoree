-- docs/specs/model-picker.md. The last good copy of the models.dev catalog.
CREATE TABLE "model_catalog" (
    "source" TEXT NOT NULL,
    "etag" TEXT,
    "data" JSONB NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "model_catalog_pkey" PRIMARY KEY ("source")
);
