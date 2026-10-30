-- R-4. The Product owns the egress ceiling of its sandboxes. Empty means repository hosts only.
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "allowedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[];

