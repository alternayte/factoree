-- docs/specs/host-credentials.md. The host credentials of a product, and the binding a sandbox
-- holds while the worker refreshes its `github` token.
CREATE TABLE "host_credential" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "username" TEXT,
    "header_name" TEXT,
    "path_prefix" TEXT,
    "realm_host" TEXT,
    "realm_path" TEXT,
    "redirect_hosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "repositories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "github_installation_id" TEXT,
    "secret_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "host_credential_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "host_credential_product_id_host_key" ON "host_credential"("product_id", "host");
CREATE INDEX "host_credential_tenant_id_idx" ON "host_credential"("tenant_id");
ALTER TABLE "host_credential" ADD CONSTRAINT "host_credential_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SandboxLease" ADD COLUMN "binding_tenant_id" TEXT;
ALTER TABLE "SandboxLease" ADD COLUMN "binding_product_id" TEXT;
ALTER TABLE "SandboxLease" ADD COLUMN "binding_hosts" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SandboxLease" ADD COLUMN "binding_repositories" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SandboxLease" ADD COLUMN "binding_bound_at" TIMESTAMP(3);
