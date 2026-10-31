-- docs/specs/release-0-1-0.md. Install settings, Product settings, sign-in, API keys and the admin audit.
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "effortImplementer" TEXT,
ADD COLUMN     "effortRefiner" TEXT,
ADD COLUMN     "effortReviewer" TEXT,
ADD COLUMN     "effortValidator" TEXT,
ADD COLUMN     "maxConcurrentRuns" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "sandboxRetentionHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "silenceMinutes" INTEGER NOT NULL DEFAULT 10;
-- CreateTable
CREATE TABLE "InstallSettings" (
    "id" TEXT NOT NULL DEFAULT 'install',
    "githubAppId" TEXT,
    "githubAppSlug" TEXT,
    "githubAppClientId" TEXT,
    "githubAppClientSecretCipher" TEXT,
    "githubAppPrivateKeyCipher" TEXT,
    "githubWebhookSecretCipher" TEXT,
    "githubBaseUrl" TEXT NOT NULL DEFAULT 'https://github.com',
    "githubApiBaseUrl" TEXT NOT NULL DEFAULT 'https://api.github.com',
    "linearClientId" TEXT,
    "linearClientSecretCipher" TEXT,
    "linearWebhookSecretCipher" TEXT,
    "sandboxProvider" TEXT,
    "sandboxUrl" TEXT,
    "sandboxApiKeyCipher" TEXT,
    "sandboxImage" TEXT,
    "sandboxRegistryUsername" TEXT,
    "sandboxRegistryTokenCipher" TEXT,
    "sandboxMaxLive" INTEGER,
    "gitAuthorName" TEXT NOT NULL DEFAULT 'Factoree',
    "gitAuthorEmail" TEXT NOT NULL DEFAULT 'factoree@users.noreply.github.com',
    "setupTokenHash" TEXT,
    "operatorTenantId" TEXT,
    "setupCompletedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InstallSettings_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "LinearMember" (
    "id" TEXT NOT NULL,
    "linearUserId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "admin" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LinearMember_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AdminAuditEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "apiKeyId" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminAuditEntry_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "auth_user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "auth_user_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "auth_session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    CONSTRAINT "auth_session_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "auth_account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "auth_account_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "auth_verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "auth_verification_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "auth_apikey" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT,
    "start" TEXT,
    "referenceId" TEXT NOT NULL,
    "prefix" TEXT,
    "key" TEXT NOT NULL,
    "refillInterval" INTEGER,
    "refillAmount" INTEGER,
    "lastRefillAt" TIMESTAMP(3),
    "enabled" BOOLEAN DEFAULT true,
    "rateLimitEnabled" BOOLEAN DEFAULT true,
    "rateLimitTimeWindow" INTEGER,
    "rateLimitMax" INTEGER,
    "requestCount" INTEGER DEFAULT 0,
    "remaining" INTEGER,
    "lastRequest" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "permissions" TEXT,
    "metadata" TEXT,
    CONSTRAINT "auth_apikey_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "LinearMember_linearUserId_key" ON "LinearMember"("linearUserId");
-- CreateIndex
CREATE INDEX "LinearMember_tenantId_idx" ON "LinearMember"("tenantId");
-- CreateIndex
CREATE INDEX "AdminAuditEntry_createdAt_idx" ON "AdminAuditEntry"("createdAt");
-- CreateIndex
CREATE UNIQUE INDEX "auth_user_email_key" ON "auth_user"("email");
-- CreateIndex
CREATE UNIQUE INDEX "auth_session_token_key" ON "auth_session"("token");
-- CreateIndex
CREATE INDEX "auth_session_userId_idx" ON "auth_session"("userId");
-- CreateIndex
CREATE INDEX "auth_account_userId_idx" ON "auth_account"("userId");
-- CreateIndex
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification"("identifier");
-- CreateIndex
CREATE INDEX "auth_apikey_configId_idx" ON "auth_apikey"("configId");
-- CreateIndex
CREATE INDEX "auth_apikey_referenceId_idx" ON "auth_apikey"("referenceId");
-- CreateIndex
CREATE INDEX "auth_apikey_key_idx" ON "auth_apikey"("key");
-- AddForeignKey
ALTER TABLE "LinearMember" ADD CONSTRAINT "LinearMember_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
