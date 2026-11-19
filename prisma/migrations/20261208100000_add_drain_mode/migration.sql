-- docs/specs/drain-mode.md. The install-wide drain mode.
ALTER TABLE "InstallSettings" ADD COLUMN "drainStartedAt" TIMESTAMP(3);
ALTER TABLE "InstallSettings" ADD COLUMN "drainStartedBy" TEXT;
ALTER TABLE "InstallSettings" ADD COLUMN "drainRelease" TEXT;
