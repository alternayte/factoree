import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { registerGitHubWebhookRoutes } from "~/http/webhooks/github.routes.js";
import type { DiscoveryOutcome } from "~/domain/products/discovery-service.js";
import type { DiscoveryService } from "~/domain/products/discovery-service.js";
import type { TenantRecord, TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { Logger, LogFields } from "~/telemetry/logger.js";

/** Records a warning per call, and no-ops every other level, so a test can assert on it. */
class FakeLogger implements Logger {
  readonly warnCalls: { message: string; fields: LogFields | undefined }[] = [];
  debug(): void {}
  info(): void {}
  warn(message: string, fields?: LogFields): void {
    this.warnCalls.push({ message, fields });
  }
  error(): void {}
  child(): Logger {
    return this;
  }
}

/** Resolves the one tenant it was seeded with, keyed by the GitHub installation id. */
class FakeTenantRegistry implements TenantRegistry {
  constructor(private readonly installationsById: Map<string, TenantRecord>) {}
  ensureTenant(): Promise<TenantRecord> {
    throw new Error("not used by this route");
  }
  findByWorkspace(): Promise<TenantRecord | null> {
    throw new Error("not used by this route");
  }
  putInstallation(): Promise<TenantRecord> {
    throw new Error("not used by this route");
  }
  getInstallationToken(): Promise<string | null> {
    throw new Error("not used by this route");
  }
  getInstallation(): Promise<null> {
    throw new Error("not used by this route");
  }
  findByGitHubInstallation(githubInstallationId: string): Promise<TenantRecord | null> {
    return Promise.resolve(this.installationsById.get(githubInstallationId) ?? null);
  }
  putGitHubInstallation(): Promise<"bound"> {
    throw new Error("not used by this route");
  }
}

/** Records every call the route makes, without touching a real DiscoveryService. */
class FakeDiscoveryService {
  readonly synced: [string, string, string][] = [];
  readonly absent: string[] = [];
  nextOutcome: DiscoveryOutcome = { kind: "registered", repositoryId: "r1", productId: "p1", productCreated: false };
  syncRepository(
    _tenantId: string,
    fullName: string,
    defaultBranch: string,
    githubInstallationId: string,
  ): Promise<DiscoveryOutcome> {
    this.synced.push([fullName, defaultBranch, githubInstallationId]);
    return Promise.resolve(this.nextOutcome);
  }
  markAbsent(_tenantId: string, fullName: string): Promise<void> {
    this.absent.push(fullName);
    return Promise.resolve();
  }
}

const TENANT: TenantRecord = { id: "tenant-1", linearWorkspaceId: "ws-1", name: "Acme" };

const build = (options: { signatureValid?: boolean; tenantBound?: boolean } = {}) => {
  const signatureValid = options.signatureValid ?? true;
  const tenantBound = options.tenantBound ?? true;
  const discovery = new FakeDiscoveryService();
  const logger = new FakeLogger();
  const installations = new Map<string, TenantRecord>();
  if (tenantBound) installations.set("42", TENANT);
  const tenants = new FakeTenantRegistry(installations);
  const started: { tenantId: string; githubInstallationId: string }[] = [];

  const app: FastifyInstance = Fastify({ logger: false });
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const buffer = body as Buffer;
    (request as unknown as { rawBody?: Buffer }).rawBody = buffer;
    try {
      done(null, buffer.length === 0 ? {} : (JSON.parse(buffer.toString("utf8")) as unknown));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  registerGitHubWebhookRoutes(app, {
    discovery: discovery as unknown as DiscoveryService,
    tenants,
    verifySignature: () => signatureValid,
    startInstallationSync: (input) => {
      started.push(input);
      return Promise.resolve();
    },
    logger,
  });

  return { app, synced: discovery.synced, absent: discovery.absent, logger, discovery, started };
};

describe("GitHub webhook route", () => {
  it("rejects a request with a bad signature", async () => {
    const { app } = build({ signatureValid: false });
    const response = await app.inject({ method: "POST", url: "/webhooks/github", payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it("syncs each repository that an installation adds", async () => {
    const { app, synced } = build({});
    await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "x-github-event": "installation_repositories" },
      payload: {
        action: "added",
        installation: { id: 42, account: { login: "acme" } },
        repositories_added: [{ full_name: "acme/api", default_branch: "main" }],
      },
    });
    expect(synced).toEqual([["acme/api", "main", "42"]]);
  });

  it("F5: logs a discovery conflict instead of discarding it", async () => {
    const { app, logger, discovery } = build({});
    discovery.nextOutcome = {
      kind: "conflict",
      reason: 'acme/api claims the team PAY for "checkout", but Product "billing" already claims it.',
    };
    await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "x-github-event": "installation_repositories" },
      payload: {
        action: "added",
        installation: { id: 42, account: { login: "acme" } },
        repositories_added: [{ full_name: "acme/api", default_branch: "main" }],
      },
    });
    expect(logger.warnCalls).toHaveLength(1);
    expect(logger.warnCalls[0]?.fields).toMatchObject({
      repository: "acme/api",
      outcome: "conflict",
      reason: 'acme/api claims the team PAY for "checkout", but Product "billing" already claims it.',
    });
    // An operator reading the message alone, with no code open, must see the repository, the
    // offending team key, and the competing Product slug.
    expect(logger.warnCalls[0]?.message).toContain("acme/api");
    expect(logger.warnCalls[0]?.message).toContain("PAY");
    expect(logger.warnCalls[0]?.message).toContain("billing");
  });

  it("syncs a push that touches the configuration file, and ignores one that does not", async () => {
    const { app, synced } = build({});
    const push = (files: string[]) => ({
      method: "POST" as const,
      url: "/webhooks/github",
      headers: { "x-github-event": "push" },
      payload: {
        ref: "refs/heads/main",
        installation: { id: 42 },
        repository: { full_name: "acme/api", default_branch: "main" },
        commits: [{ modified: files, added: [], removed: [] }],
      },
    });

    await app.inject(push(["src/index.ts"]));
    expect(synced).toEqual([]);

    await app.inject(push([".factoree/config.yaml"]));
    expect(synced).toEqual([["acme/api", "main", "42"]]);
  });

  it("ignores a push to a branch other than the repository default, even when it touches the configuration file", async () => {
    const { app, synced } = build({});
    await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "x-github-event": "push" },
      payload: {
        ref: "refs/heads/feature-x",
        installation: { id: 42 },
        repository: { full_name: "acme/api", default_branch: "main" },
        commits: [{ modified: [".factoree/config.yaml"], added: [], removed: [] }],
      },
    });
    expect(synced).toEqual([]);
  });

  it("marks a repository absent when a push removes the configuration file", async () => {
    const { app, synced, absent } = build({});
    await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "x-github-event": "push" },
      payload: {
        ref: "refs/heads/main",
        installation: { id: 42 },
        repository: { full_name: "acme/api", default_branch: "main" },
        commits: [{ modified: [], added: [], removed: [".factoree/config.yaml"] }],
      },
    });
    expect(absent).toEqual(["acme/api"]);
    expect(synced).toEqual([]);
  });

  it("marks a repository absent when an installation revokes access to it", async () => {
    const { app, synced, absent } = build({});
    await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "x-github-event": "installation_repositories" },
      payload: {
        action: "removed",
        installation: { id: 42, account: { login: "acme" } },
        repositories_added: [],
        repositories_removed: [{ full_name: "acme/api" }],
      },
    });
    expect(absent).toEqual(["acme/api"]);
    expect(synced).toEqual([]);
  });

  it("answers 200 and does no work for an installation Factoree has no tenant for", async () => {
    const { app, synced, absent, logger } = build({ tenantBound: false });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "x-github-event": "installation_repositories" },
      payload: {
        action: "added",
        installation: { id: 42, account: { login: "acme" } },
        repositories_added: [{ full_name: "acme/api", default_branch: "main" }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(synced).toEqual([]);
    expect(absent).toEqual([]);
    expect(logger.warnCalls).toHaveLength(1);
    expect(logger.warnCalls[0]?.fields).toMatchObject({
      installation_id: "42",
      account_login: "acme",
    });
  });

  it("starts a sync when an installation is created", async () => {
    const { app, started } = build({});

    await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "x-github-event": "installation" },
      payload: { action: "created", installation: { id: 42, account: { login: "acme" } } },
    });

    expect(started).toEqual([{ tenantId: "tenant-1", githubInstallationId: "42" }]);
  });

  it("starts no sync for an unbound installation", async () => {
    const { app, started, logger } = build({ tenantBound: false });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "x-github-event": "installation" },
      payload: { action: "created", installation: { id: 99, account: { login: "other" } } },
    });

    expect(response.statusCode).toBe(200);
    expect(started).toEqual([]);
    expect(logger.warnCalls[0]?.fields).toMatchObject({ installation_id: "99" });
  });

  it("starts a sync when a suspended installation is unsuspended", async () => {
    const { app, started } = build({});

    await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "x-github-event": "installation" },
      payload: { action: "unsuspend", installation: { id: 42, account: { login: "acme" } } },
    });

    expect(started).toEqual([{ tenantId: "tenant-1", githubInstallationId: "42" }]);
  });

  it.each(["deleted", "suspend"])("starts no sync when an installation is %s", async (action) => {
    const { app, started } = build({});

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "x-github-event": "installation" },
      payload: { action, installation: { id: 42, account: { login: "acme" } } },
    });

    expect(response.statusCode).toBe(200);
    expect(started).toEqual([]);
  });
});
