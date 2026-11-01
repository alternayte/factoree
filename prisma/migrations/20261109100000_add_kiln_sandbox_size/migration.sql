-- docs/specs/kiln-sandbox-size.md. The size of each Kiln sandbox, and the Kiln template of each
-- warm snapshot in place of its image.

-- AlterTable
ALTER TABLE "InstallSettings" ADD COLUMN "sandboxVcpus" INTEGER,
ADD COLUMN "sandboxMemoryMb" INTEGER;

-- AlterTable
ALTER TABLE "WarmSnapshot" ADD COLUMN "template" TEXT;

-- A snapshot taken before this migration ran at 2 vCPUs and 4096 MB. An image without a digest
-- names no template, so its row matches nothing and the next run replaces it.
UPDATE "WarmSnapshot"
SET "template" = COALESCE(
  'factoree-' || substring("image" from '@sha256:([0-9a-f]{16})[0-9a-f]{48}$') || '-2c-4096m',
  ''
);

ALTER TABLE "WarmSnapshot" ALTER COLUMN "template" SET NOT NULL;
ALTER TABLE "WarmSnapshot" DROP COLUMN "image";
