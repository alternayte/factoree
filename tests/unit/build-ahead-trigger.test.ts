import { describe, expect, it } from "vitest";
import { BuildAheadTrigger, bootstrapKeyOfConfig, projectDefaultsOf, type BuildAheadRequest } from "~/domain/runs/build-ahead.js";
import type { ProductRecord } from "~/domain/products/product-registry.js";
import type { RepositoryRecord } from "~/domain/products/repository-registry.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { RepositoryFileEntry } from "~/domain/runs/warm-snapshot.js";

const CONFIG = (bootstrap: string, verify: string): string =>
  `version: 1\nidentity:\n  product: shop\n  linear:\n    teamKey: SHP\nbootstrap:\n  command: ${bootstrap}\n` +
  `verify:\n  commands:\n    - name: test\n      run: ${verify}\nsandbox:\n  allowedDomains:\n    - proxy.golang.org\n`;

const KEYED_CONFIG =
  "version: 1\nidentity:\n  product: shop\n  linear:\n    teamKey: SHP\nbootstrap:\n  command: dotnet restore\n" +
  "  keyFiles:\n    - \"**/packages.lock.json\"\nverify:\n  commands:\n    - name: test\n      run: dotnet test\n";

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

const triggerFor = (
  config: string,
  storedConfig: string,
  files: RepositoryFileEntry[] | null = [],
  storedFiles: RepositoryFileEntry[] = [],
) => {
  const requests: BuildAheadRequest[] = [];
  const stored = bootstrapKeyOfConfig({ content: storedConfig, sha: "old" }, projectDefaultsOf(product), storedFiles)!;
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
    listFiles: () => Promise.resolve(files),
    repositoryBaseUrl: () => Promise.resolve("https://github.com"),
    logger: createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
  });
  return { trigger, requests };
};

describe("BuildAheadTrigger (docs/specs/run-speed.md)", () => {
  it("requests no build-ahead when a push changes only the verify commands", async () => {
    const { trigger, requests } = triggerFor(CONFIG("go mod download", "go test ./..."), CONFIG("go mod download", "go vet ./..."));
    await trigger.afterPush("tenant-1", "acme/shop");
    expect(requests).toEqual([]);
  });

  it("requests one build-ahead when a push changes the bootstrap command", async () => {
    const { trigger, requests } = triggerFor(CONFIG("go mod download && go build ./...", "go test ./..."), CONFIG("go mod download", "go test ./..."));
    await trigger.afterPush("tenant-1", "acme/shop");
    expect(requests).toEqual([{ tenantId: "tenant-1", productId: "product-1", repositoryFullName: "acme/shop" }]);
  });

  it("requests one build-ahead when a push changes a key file and nothing else (repository-setup-and-services.md)", async () => {
    const config = KEYED_CONFIG;
    const lock = (sha: string): RepositoryFileEntry[] => [
      { path: "src/App/packages.lock.json", sha },
      { path: "README.md", sha: "readme" },
    ];
    const unchanged = triggerFor(config, config, lock("a"), lock("a"));
    await unchanged.trigger.afterPush("tenant-1", "acme/shop");
    expect(unchanged.requests).toEqual([]);
    const changed = triggerFor(config, config, lock("b"), lock("a"));
    await changed.trigger.afterPush("tenant-1", "acme/shop");
    expect(changed.requests).toHaveLength(1);
  });

  it("ignores a change to a file no key glob names, and to the config file itself", async () => {
    const config = KEYED_CONFIG;
    const before: RepositoryFileEntry[] = [{ path: "README.md", sha: "a" }, { path: ".factoree/config.yaml", sha: "a" }];
    const after: RepositoryFileEntry[] = [{ path: "README.md", sha: "b" }, { path: ".factoree/config.yaml", sha: "b" }];
    const { trigger, requests } = triggerFor(config, config, after, before);
    await trigger.afterPush("tenant-1", "acme/shop");
    expect(requests).toEqual([]);
  });

  it("requests a build-ahead when GitHub truncated the tree", async () => {
    const { trigger, requests } = triggerFor(KEYED_CONFIG, KEYED_CONFIG, null);
    await trigger.afterPush("tenant-1", "acme/shop");
    expect(requests).toHaveLength(1);
  });

  it("never fails the request that caused it", async () => {
    const { trigger } = triggerFor("version: [", CONFIG("go mod download", "go test ./..."));
    await expect(trigger.afterPush("tenant-1", "acme/shop")).resolves.toBeUndefined();
  });
});
