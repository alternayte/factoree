-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "linearWorkspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinearInstallation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "linearWorkspaceId" TEXT NOT NULL,
    "appUserId" TEXT,
    "accessTokenCipher" TEXT NOT NULL,
    "refreshTokenCipher" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinearInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primaryRepository" TEXT NOT NULL,
    "referenceRepositories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "linearTeamId" TEXT,
    "defaultAutonomy" TEXT NOT NULL DEFAULT 'L2',
    "maxRunMinutes" INTEGER NOT NULL DEFAULT 90,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectSecret" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "valueCipher" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linearIssueId" TEXT,
    "linearAgentSessionId" TEXT NOT NULL,
    "temporalWorkflowId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "failureReason" TEXT,
    "autonomyLevel" TEXT NOT NULL,
    "implementerRunner" TEXT,
    "validatorRunner" TEXT,
    "reviewerRunner" TEXT,
    "spriteId" TEXT,
    "baseSha" TEXT,
    "patchSha256" TEXT,
    "commitSha" TEXT,
    "pullRequestUrl" TEXT,
    "contextContractVersion" TEXT,
    "validationContractVersion" TEXT,
    "repairCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentExecution" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "runner" TEXT NOT NULL,
    "model" TEXT,
    "sessionRef" TEXT,
    "promptVersion" TEXT,
    "durationMs" INTEGER,
    "finalResult" JSONB,
    "costMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedWebhook" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "deliveryId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_linearWorkspaceId_key" ON "Tenant"("linearWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "LinearInstallation_linearWorkspaceId_key" ON "LinearInstallation"("linearWorkspaceId");

-- CreateIndex
CREATE INDEX "Project_tenantId_idx" ON "Project"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_tenantId_key_key" ON "Project"("tenantId", "key");

-- CreateIndex
CREATE INDEX "ProjectSecret_tenantId_idx" ON "ProjectSecret"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSecret_projectId_name_key" ON "ProjectSecret"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Run_linearAgentSessionId_key" ON "Run"("linearAgentSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Run_temporalWorkflowId_key" ON "Run"("temporalWorkflowId");

-- CreateIndex
CREATE INDEX "Run_tenantId_idx" ON "Run"("tenantId");

-- CreateIndex
CREATE INDEX "Run_projectId_idx" ON "Run"("projectId");

-- CreateIndex
CREATE INDEX "AgentExecution_tenantId_idx" ON "AgentExecution"("tenantId");

-- CreateIndex
CREATE INDEX "AgentExecution_runId_idx" ON "AgentExecution"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedWebhook_deliveryId_key" ON "ProcessedWebhook"("deliveryId");

-- CreateIndex
CREATE INDEX "ProcessedWebhook_tenantId_idx" ON "ProcessedWebhook"("tenantId");

-- AddForeignKey
ALTER TABLE "LinearInstallation" ADD CONSTRAINT "LinearInstallation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSecret" ADD CONSTRAINT "ProjectSecret_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentExecution" ADD CONSTRAINT "AgentExecution_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessedWebhook" ADD CONSTRAINT "ProcessedWebhook_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
