import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encryptSecret } from "~/domain/policy/crypto.js";
import { PrismaInstallSettingsStore } from "~/persistence/prisma/install-settings.prisma.js";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";

/**
 * The worker's redactor guards every log line, activity error and Temporal history record of the
 * process that captures agent, sandbox and git output. docs/specs/release-0-1-0.md moved the
 * GitHub App key, the webhook secrets and the sandbox key from the environment to the install
 * settings, so the redactor learns each credential when the settings store decrypts it.
 */
const KEY = "ab".repeat(32);

describe("the redactor of the API and the worker", () => {
  it("holds the master key and learns every credential the install settings decrypt", () => {
    for (const path of ["src/bin/worker.ts", "src/bin/api.ts"]) {
      const source = readFileSync(path, "utf8");
      expect(source, path).toContain("new Redactor([env.FACTOREE_MASTER_KEY])");
      expect(source, path).toMatch(
        /new PrismaInstallSettingsStore\(prisma, env\.FACTOREE_MASTER_KEY, \(value\) => redactor\.addSecret\(value\)\)/,
      );
    }
  });

  it("hands each decrypted credential to the redactor hook, and no plain value", async () => {
    const row = {
      id: "install",
      githubAppId: "1",
      githubAppSlug: "factoree",
      githubAppClientId: "Iv1.client",
      githubAppClientSecretCipher: encryptSecret("client-secret-value", KEY),
      githubAppPrivateKeyCipher: encryptSecret("-----BEGIN PRIVATE KEY-----", KEY),
      githubWebhookSecretCipher: encryptSecret("github-webhook-value", KEY),
      githubBaseUrl: "https://github.com",
      githubApiBaseUrl: "https://api.github.com",
      linearClientId: "linear-client",
      linearClientSecretCipher: encryptSecret("linear-secret-value", KEY),
      linearWebhookSecretCipher: encryptSecret("linear-webhook-value", KEY),
      sandboxProvider: "kiln",
      sandboxUrl: "https://kiln.example.test",
      sandboxApiKeyCipher: encryptSecret("kiln-key-value", KEY),
      sandboxImage: null,
      sandboxRegistryUsername: null,
      sandboxRegistryTokenCipher: null,
      sandboxMaxLive: null,
      gitAuthorName: "Factoree",
      gitAuthorEmail: "factoree@users.noreply.github.com",
      setupTokenHash: null,
      operatorTenantId: null,
      setupCompletedAt: null,
      updatedAt: new Date(),
    };
    const prisma = { installSettings: { upsert: () => Promise.resolve(row) } } as unknown as FactoreePrismaClient;
    const learned: string[] = [];
    const settings = await new PrismaInstallSettingsStore(prisma, KEY, (value) => learned.push(value)).read();

    expect(learned.sort()).toEqual(
      [
        "client-secret-value",
        "-----BEGIN PRIVATE KEY-----",
        "github-webhook-value",
        "linear-secret-value",
        "linear-webhook-value",
        "kiln-key-value",
      ].sort(),
    );
    expect(settings.sandbox.apiKey).toBe("kiln-key-value");
  });
});
