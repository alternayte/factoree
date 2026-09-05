-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "linearTeamKey" TEXT NOT NULL,
    "linearTeamId" TEXT NOT NULL,
    "defaultAutonomy" TEXT NOT NULL DEFAULT 'L0',
    "maxRunMinutes" INTEGER NOT NULL DEFAULT 90,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "configSha" TEXT NOT NULL,
    "requestedSecretNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "absentSince" TIMESTAMP(3),

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductSecret" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "valueCipher" TEXT NOT NULL,
    "injectIntoImplementer" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL DEFAULT 'test',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunTarget" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'primary',
    "selectionReason" TEXT NOT NULL,
    "baseSha" TEXT,
    "patchSha256" TEXT,
    "commitSha" TEXT,
    "pullRequestUrl" TEXT,
    "mergeOrder" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_tenantId_idx" ON "Product"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_slug_key" ON "Product"("tenantId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_linearTeamId_key" ON "Product"("tenantId", "linearTeamId");

-- CreateIndex
CREATE INDEX "Repository_productId_idx" ON "Repository"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_tenantId_fullName_key" ON "Repository"("tenantId", "fullName");

-- CreateIndex
CREATE INDEX "ProductSecret_tenantId_idx" ON "ProductSecret"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSecret_productId_name_key" ON "ProductSecret"("productId", "name");

-- CreateIndex
CREATE INDEX "RunTarget_runId_idx" ON "RunTarget"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "RunTarget_runId_repositoryId_key" ON "RunTarget"("runId", "repositoryId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSecret" ADD CONSTRAINT "ProductSecret_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunTarget" ADD CONSTRAINT "RunTarget_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunTarget" ADD CONSTRAINT "RunTarget_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
