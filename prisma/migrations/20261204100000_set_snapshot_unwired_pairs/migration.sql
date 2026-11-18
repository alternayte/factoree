-- docs/specs/change-sets.md, DI-21.148. A set snapshot records each wired pair its build-ahead could
-- not start within the sandbox size, with the reason. A run of the set tests those targets alone.

-- AlterTable
ALTER TABLE "WarmSnapshot" ADD COLUMN     "unwired_pairs" JSONB;
