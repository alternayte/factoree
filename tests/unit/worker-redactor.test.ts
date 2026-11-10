import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encryptSecret } from "~/domain/policy/crypto.js";
import { PrismaSandboxProviderStore } from "~/persistence/prisma/sandbox-provider.prisma.js";
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
      sandboxImage: null,
      sandboxRegistryUsername: "robot",
      sandboxRegistryTokenCipher: encryptSecret("registry-token-value", KEY),
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
        "registry-token-value",
      ].sort(),
    );
    expect(settings.sandbox.registryToken).toBe("registry-token-value");
  });

  // docs/specs/sandbox-provider-spillover.md. The key of each sandbox provider reaches the redactor too.
  it("hands each decrypted sandbox provider key to the redactor hook", async () => {
    expect(readFileSync("src/bin/worker.ts", "utf8")).toMatch(
      /new PrismaSandboxProviderStore\(prisma, env\.FACTOREE_MASTER_KEY, \(value\) => redactor\.addSecret\(value\)\)/,
    );
    const row = {
      id: "kiln",
      name: "Kiln",
      type: "kiln",
      url: "https://kiln.example.test",
      apiKeyCipher: encryptSecret("kiln-key-value", KEY),
      maxLive: 6,
      vcpus: null,
      memoryMb: null,
      priority: 1,
      enabled: true,
      downUntil: null,
      downReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = { sandboxProvider: { findMany: () => Promise.resolve([row]) } } as unknown as FactoreePrismaClient;
    const learned: string[] = [];
    const providers = await new PrismaSandboxProviderStore(prisma, KEY, (value) => learned.push(value)).list();
    expect(learned).toEqual(["kiln-key-value"]);
    expect(providers[0]?.apiKey).toBe("kiln-key-value");
  });
});
