-- docs/specs/claude-code-runner.md. The Product selects the runner and the model of each role.
-- Every existing Product keeps opencode and its model, so it runs as it ran before.
ALTER TABLE "Product" ADD COLUMN "default_runner" TEXT NOT NULL DEFAULT 'opencode';
ALTER TABLE "Product" ADD COLUMN "runner_implementer" TEXT;
ALTER TABLE "Product" ADD COLUMN "runner_refiner" TEXT;
ALTER TABLE "Product" ADD COLUMN "runner_validator" TEXT;
ALTER TABLE "Product" ADD COLUMN "runner_reviewer" TEXT;
ALTER TABLE "Product" ADD COLUMN "runner_setup" TEXT;
ALTER TABLE "Product" ADD COLUMN "model_implementer" TEXT;
ALTER TABLE "Product" ADD COLUMN "model_refiner" TEXT;
ALTER TABLE "Product" ADD COLUMN "model_validator" TEXT;
ALTER TABLE "Product" ADD COLUMN "model_reviewer" TEXT;
ALTER TABLE "Product" ADD COLUMN "model_setup" TEXT;
