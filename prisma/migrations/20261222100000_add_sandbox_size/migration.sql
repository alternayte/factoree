-- docs/specs/sandbox-memory-and-size.md. The `sandbox` minimum of a repository, the memory budget and
-- the largest sandbox of a provider, and the memory of each lease. Every column is nullable, so an
-- existing row keeps its behaviour: no minimum, no budget, the type default maximum.
ALTER TABLE "Repository" ADD COLUMN "sandbox_vcpus" INTEGER;
ALTER TABLE "Repository" ADD COLUMN "sandbox_memory_mb" INTEGER;
ALTER TABLE "Repository" ADD COLUMN "sandbox_disk_mb" INTEGER;
ALTER TABLE "SandboxProvider" ADD COLUMN "memory_budget_mb" INTEGER;
ALTER TABLE "SandboxProvider" ADD COLUMN "max_vcpus" INTEGER;
ALTER TABLE "SandboxProvider" ADD COLUMN "max_memory_mb" INTEGER;
ALTER TABLE "SandboxLease" ADD COLUMN "memory_mb" INTEGER;
