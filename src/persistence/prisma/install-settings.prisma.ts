import type { InstallSettings as InstallSettingsRow } from "@prisma/client";
import type { FactoreePrismaClient } from "./client.js";
import { decryptSecret, encryptSecret } from "~/domain/policy/crypto.js";
import type { InstallSettings, InstallSettingsPatch, InstallSettingsStore } from "~/domain/settings/install-settings.js";

const ROW_ID = "install";

/**
 * The install settings row. Every credential column holds AES-256-GCM cipher text under the
 * master key. A read decrypts, a write encrypts, and no plain credential reaches the database.
 */
export class PrismaInstallSettingsStore implements InstallSettingsStore {
  constructor(
    private readonly prisma: FactoreePrismaClient,
    private readonly masterKey: string,
    /**
     * Receives every credential this store decrypts. The API and the worker pass it to the log
     * redactor, so a stored credential never reaches a log line (SDD section 60).
     */
    private readonly onCredential: (value: string) => void = () => undefined,
  ) {}

  private open(cipher: string | null): string | null {
    if (cipher === null) return null;
    const value = decryptSecret(cipher, this.masterKey);
    this.onCredential(value);
    return value;
  }

  /** undefined keeps the column, null clears it, and a string replaces it. */
  private seal(value: string | null | undefined): string | null | undefined {
    if (value === undefined || value === null) return value;
    return encryptSecret(value, this.masterKey);
  }

  private async row(): Promise<InstallSettingsRow> {
    return this.prisma.installSettings.upsert({ where: { id: ROW_ID }, create: { id: ROW_ID }, update: {} });
  }

  private toSettings(row: InstallSettingsRow): InstallSettings {
    return {
      github: {
        appId: row.githubAppId,
        appSlug: row.githubAppSlug,
        clientId: row.githubAppClientId,
        clientSecret: this.open(row.githubAppClientSecretCipher),
        privateKey: this.open(row.githubAppPrivateKeyCipher),
        webhookSecret: this.open(row.githubWebhookSecretCipher),
        baseUrl: row.githubBaseUrl,
        apiBaseUrl: row.githubApiBaseUrl,
      },
      linear: {
        clientId: row.linearClientId,
        clientSecret: this.open(row.linearClientSecretCipher),
        webhookSecret: this.open(row.linearWebhookSecretCipher),
      },
      sandbox: {
        image: row.sandboxImage,
        registryUsername: row.sandboxRegistryUsername,
        registryToken: this.open(row.sandboxRegistryTokenCipher),
      },
      gitAuthor: { name: row.gitAuthorName, email: row.gitAuthorEmail },
      operatorTenantId: row.operatorTenantId,
      setupCompletedAt: row.setupCompletedAt,
    };
  }

  async read(): Promise<InstallSettings> {
    return this.toSettings(await this.row());
  }

  async update(patch: InstallSettingsPatch): Promise<InstallSettings> {
    const { github = {}, linear = {}, sandbox = {}, gitAuthor = {} } = patch;
    const data = {
      githubAppId: github.appId,
      githubAppSlug: github.appSlug,
      githubAppClientId: github.clientId,
      githubAppClientSecretCipher: this.seal(github.clientSecret),
      githubAppPrivateKeyCipher: this.seal(github.privateKey),
      githubWebhookSecretCipher: this.seal(github.webhookSecret),
      githubBaseUrl: github.baseUrl,
      githubApiBaseUrl: github.apiBaseUrl,
      linearClientId: linear.clientId,
      linearClientSecretCipher: this.seal(linear.clientSecret),
      linearWebhookSecretCipher: this.seal(linear.webhookSecret),
      sandboxImage: sandbox.image,
      sandboxRegistryUsername: sandbox.registryUsername,
      sandboxRegistryTokenCipher: this.seal(sandbox.registryToken),
      gitAuthorName: gitAuthor.name,
      gitAuthorEmail: gitAuthor.email,
      operatorTenantId: patch.operatorTenantId,
    };
    const defined = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
    const row = await this.prisma.installSettings.upsert({
      where: { id: ROW_ID },
      create: { id: ROW_ID, ...defined },
      update: defined,
    });
    return this.toSettings(row);
  }

  async setupTokenHash(): Promise<string | null> {
    return (await this.row()).setupTokenHash;
  }

  async storeSetupTokenHash(hash: string): Promise<void> {
    await this.prisma.installSettings.upsert({
      where: { id: ROW_ID },
      create: { id: ROW_ID, setupTokenHash: hash },
      update: { setupTokenHash: hash },
    });
  }

  async completeSetup(at: Date): Promise<void> {
    await this.prisma.installSettings.update({
      where: { id: ROW_ID },
      data: { setupCompletedAt: at, setupTokenHash: null },
    });
  }
}
