-- Issue #39, DI-21.66. The most criteria a refiner proposal may hold, a Product setting.
ALTER TABLE "Product" ADD COLUMN "refiner_criteria_limit" INTEGER NOT NULL DEFAULT 20;
