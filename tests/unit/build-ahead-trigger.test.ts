import { describe, expect, it } from "vitest";
import { BuildAheadTrigger, bootstrapKeyOfConfig, projectDefaultsOf, type BuildAheadRequest } from "~/domain/runs/build-ahead.js";
import type { ProductRecord } from "~/domain/products/product-registry.js";
import type { RepositoryRecord } from "~/domain/products/repository-registry.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";

const CONFIG = (bootstrap: string, verify: string): string =>
  `version: 1\nidentity:\n  product: shop\n  linear:\n    teamKey: SHP\nbootstrap:\n  command: ${bootstrap}\n` +
  `verify:\n  commands:\n    - name: test\n      run: ${verify}\nsandbox:\n  allowedDomains:\n    - proxy.golang.org\n`;

const product = { id: "product-1", allowedDomains: ["proxy.golang.org"], sandboxRetentionHours: 24 } as ProductRecord;

const repository: RepositoryRecord = {
  id: "repository-1",
  tenantId: "tenant-1",
  productId: "product-1",
  fullName: "acme/shop",
  defaultBranch: "main",
  configSha: "sha",
  requestedSecretNames: [],
  linearProjects: [],
  discoveredAt: new Date(0),
  lastSeenAt: new Date(0),
  absentSince: null,
  githubInstallationId: "42",
};

const triggerFor = (config: string, storedConfig: string) => {
  const requests: BuildAheadRequest[] = [];
  const stored = bootstrapKeyOfConfig({ content: storedConfig, sha: "old" }, projectDefaultsOf(product));
  const trigger = new BuildAheadTrigger({
    request: (request) => {
      requests.push(request);
      return Promise.resolve();
    },
    products: { findById: () => Promise.resolve(product) },
    repositories: {
      listByProduct: () => Promise.resolve([repository]),
      findByFullName: () => Promise.resolve(repository),
      listPresent: () => Promise.resolve([repository]),
    },
    snapshotKeys: () => Promise.resolve([stored]),
    readConfig: () => Promise.resolve({ content: config, sha: "new" }),
    repositoryBaseUrl: () => Promise.resolve("https://github.com"),
    logger: createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
  });
  return { trigger, requests };
};

describe("BuildAheadTrigger (docs/specs/run-speed.md)", () => {
  it("requests no build-ahead when a push changes only the verify commands", async () => {
    const { trigger, requests } = triggerFor(CONFIG("go mod download", "go test ./..."), CONFIG("go mod download", "go vet ./..."));
    await trigger.afterConfigPush("tenant-1", "acme/shop");
    expect(requests).toEqual([]);
  });

  it("requests one build-ahead when a push changes the bootstrap command", async () => {
    const { trigger, requests } = triggerFor(CONFIG("go mod download && go build ./...", "go test ./..."), CONFIG("go mod download", "go test ./..."));
    await trigger.afterConfigPush("tenant-1", "acme/shop");
    expect(requests).toEqual([{ tenantId: "tenant-1", productId: "product-1", repositoryFullName: "acme/shop" }]);
  });

  it("never fails the request that caused it", async () => {
    const { trigger } = triggerFor("version: [", CONFIG("go mod download", "go test ./..."));
    await expect(trigger.afterConfigPush("tenant-1", "acme/shop")).resolves.toBeUndefined();
  });
});
