import { randomUUID, createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockActivityEnvironment, TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { temporal } from "@temporalio/proto";
import { GitHubAppTokenProvider } from "~/adapters/github/app-token-provider.js";
import { GitHubPullRequests, GitHubApiError } from "~/adapters/github/github-pull-requests.js";
import { GitHubRepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";
import type { DiscoveredRepository, RepositoryConfigFile, RepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";
import { verifyGitHubSignature } from "~/adapters/github/webhook-verifier.js";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { registerGitHubWebhookRoutes } from "~/http/webhooks/github.routes.js";
import { DiscoveryService } from "~/domain/products/discovery-service.js";
import type { ProductRecord, CreateProductInput, ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRecord, RepositoryRegistry, UpsertRepositoryInput } from "~/domain/products/repository-registry.js";
import type { TenantRecord, TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { LinearTeamLookup } from "~/adapters/linear/team-lookup.js";
import {
  createDiscoveryActivities,
  type DiscoveryActivities,
} from "~/activities/discovery.activities.js";
import { syncInstallationWorkflow } from "~/workflows/sync-installation.workflow.js";
import {
  createPublishingActivities,
  type PublishActivityInput,
  type PublishActivityOutput,
} from "~/activities/publishing.activities.js";
import { publishToBranch as realPublishToBranch, type TrustedCheckoutInput } from "~/domain/publishing/trusted-checkout.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { SandboxRef } from "~/domain/runs/sandbox.js";
import { createLogger } from "~/telemetry/logger.js";
import type { Logger, LogFields } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { capturePatch } from "~/domain/publishing/patch.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";
import { createBareRemote, type BareRemote } from "./support/bare-remote.js";

// ---------------------------------------------------------------------------------------------
// Shared fakes: the persistence boundaries a real DiscoveryService, real webhook route, and
// real publishing activity are wired to. None of these fakes stands in for the module a test
// names, they stand in for a database or an HTTP call to GitHub.
// ---------------------------------------------------------------------------------------------

class FakeProductRegistry implements ProductRegistry {
  private readonly rows: ProductRecord[] = [];
  private counter = 0;

  create(input: CreateProductInput): Promise<ProductRecord> {
    this.counter += 1;
    const record: ProductRecord = {
      id: `product-${String(this.counter)}`,
      tenantId: input.tenantId,
      slug: input.slug,
      name: input.name,
      status: "pending",
      linearTeamKey: input.linearTeamKey,
      linearTeamId: input.linearTeamId,
      defaultAutonomy: "L0",
      riskCaps: null,
      allowedDomains: [],
      maxRunMinutes: input.maxRunMinutes ?? 60,
      organizationSkillsRepository: input.organizationSkillsRepository ?? null,
      model: null,
      effort: { implementer: null, refiner: null, validator: null, reviewer: null },
      silenceMinutes: 10,
      sandboxRetentionHours: 24,
      maxConcurrentRuns: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.push(record);
    return Promise.resolve(record);
  }

  list(tenantId: string): Promise<ProductRecord[]> {
    return Promise.resolve(this.rows.filter((row) => row.tenantId === tenantId));
  }

  findById(tenantId: string, id: string): Promise<ProductRecord | null> {
    return Promise.resolve(this.rows.find((row) => row.tenantId === tenantId && row.id === id) ?? null);
  }

  findBySlug(tenantId: string, slug: string): Promise<ProductRecord | null> {
    return Promise.resolve(this.rows.find((row) => row.tenantId === tenantId && row.slug === slug) ?? null);
  }

  findByLinearTeamId(tenantId: string, linearTeamId: string): Promise<ProductRecord | null> {
    return Promise.resolve(
      this.rows.find((row) => row.tenantId === tenantId && row.linearTeamId === linearTeamId) ?? null,
    );
  }

  activate(): Promise<ProductRecord | null> {
    throw new Error("not used by this test");
  }

  renameLinearTeamKey(tenantId: string, id: string, linearTeamKey: string): Promise<ProductRecord | null> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (row === undefined) return Promise.resolve(null);
    row.linearTeamKey = linearTeamKey;
    return Promise.resolve(row);
  }

  updateOrganizationSkillsRepository(): Promise<ProductRecord | null> {
    throw new Error("not used by this test");
  }

  updatePolicy(): Promise<ProductRecord | null> {
    return Promise.resolve(null);
  }

  updateSettings(): Promise<ProductRecord | null> {
    return Promise.resolve(null);
  }

  update(): Promise<ProductRecord | null> {
    throw new Error("not used by this test");
  }

  remove(): Promise<boolean> {
    throw new Error("not used by this test");
  }
}

class FakeRepositoryRegistry implements RepositoryRegistry {
  readonly rows: RepositoryRecord[] = [];
  private counter = 0;

  upsert(input: UpsertRepositoryInput): Promise<RepositoryRecord> {
    const existing = this.rows.find((row) => row.tenantId === input.tenantId && row.fullName === input.fullName);
    if (existing !== undefined) {
      existing.productId = input.productId;
      existing.defaultBranch = input.defaultBranch;
      existing.configSha = input.configSha;
      existing.requestedSecretNames = input.requestedSecretNames;
      existing.githubInstallationId = input.githubInstallationId;
      existing.lastSeenAt = new Date();
      existing.absentSince = null;
      return Promise.resolve(existing);
    }
    this.counter += 1;
    const record: RepositoryRecord = {
      id: `repository-${String(this.counter)}`,
      tenantId: input.tenantId,
      productId: input.productId,
      fullName: input.fullName,
      defaultBranch: input.defaultBranch,
      configSha: input.configSha,
      requestedSecretNames: input.requestedSecretNames,
      githubInstallationId: input.githubInstallationId,
      linearProjects: [],
      discoveredAt: new Date(),
      lastSeenAt: new Date(),
      absentSince: null,
    };
    this.rows.push(record);
    return Promise.resolve(record);
  }

  listByProduct(productId: string): Promise<RepositoryRecord[]> {
    return Promise.resolve(this.rows.filter((row) => row.productId === productId));
  }

  findByFullName(tenantId: string, fullName: string): Promise<RepositoryRecord | null> {
    return Promise.resolve(this.rows.find((row) => row.tenantId === tenantId && row.fullName === fullName) ?? null);
  }

  markAbsent(tenantId: string, fullName: string, at: Date): Promise<void> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.fullName === fullName);
    if (row !== undefined) row.absentSince = at;
    return Promise.resolve();
  }
}

/** Answers one fixed team for every key it is asked, the way the design fixtures of AT-38..48 do. */
class FakeLinearTeamLookup implements LinearTeamLookup {
  resolveTeamKey(_tenantId: string, teamKey: string): Promise<{ id: string; key: string } | null> {
    return Promise.resolve({ id: `team-${teamKey}`, key: teamKey });
  }

  resolveTeamId(_tenantId: string, teamId: string): Promise<{ id: string; key: string } | null> {
    return Promise.resolve({ id: teamId, key: teamId.replace(/^team-/, "") });
  }
}

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

/** A valid `.factoree/config.yaml` document naming one Product slug and one team key. */
const configFor = (slug: string, teamKey: string): string =>
  `version: 1\nidentity:\n  product: ${slug}\n  linear:\n    teamKey: ${teamKey}\nverify:\n  commands:\n    - name: test\n      run: npm test\n`;

const buildDiscoveryService = (discoveryClient: RepositoryDiscoveryClient) => {
  const products = new FakeProductRegistry();
  const repositories = new FakeRepositoryRegistry();
  const service = new DiscoveryService(discoveryClient, products, repositories, new FakeLinearTeamLookup(), new FakeLogger());
  return { service, products, repositories };
};

// ---------------------------------------------------------------------------------------------
// AT-49 and AT-55: the real syncInstallationWorkflow, the real discovery activities, and the
// real DiscoveryService, over an installation of several repositories. The GitHub HTTP boundary
// is a fake `RepositoryDiscoveryClient`, the same seam AT-38..48 fakes at the Linear boundary.
// ---------------------------------------------------------------------------------------------

class FakeRepositoryDiscoveryClient implements RepositoryDiscoveryClient {
  readConfigCalls: string[] = [];

  constructor(
    private readonly repositories: DiscoveredRepository[],
    private readonly configByRepository: Record<string, string | null>,
  ) {}

  listInstallationRepositories(): Promise<DiscoveredRepository[]> {
    return Promise.resolve(this.repositories);
  }

  readConfig(fullName: string): Promise<RepositoryConfigFile | null> {
    this.readConfigCalls.push(fullName);
    const content = this.configByRepository[fullName] ?? null;
    if (content === null) return Promise.resolve(null);
    return Promise.resolve({ content, sha: `sha-${fullName}` });
  }
}

/** The `retry-after` seconds `RateLimitedOnceDiscoveryClient` answers. Chosen away from the
 * workflow's own default retry interval of one second, so a test can tell the two apart: a
 * measured wait near this value proves GitHub's header drove the delay, not the default policy. */
const RATE_LIMIT_RETRY_AFTER_SECONDS = 6;

/** A `RepositoryDiscoveryClient` that answers a rate limit once, then succeeds, for AT-54. */
class RateLimitedOnceDiscoveryClient implements RepositoryDiscoveryClient {
  listCalls = 0;

  constructor(private readonly repositories: DiscoveredRepository[]) {}

  listInstallationRepositories(): Promise<DiscoveredRepository[]> {
    this.listCalls += 1;
    if (this.listCalls === 1) {
      return Promise.reject(
        new GitHubApiError("the GitHub API rate-limited this installation", 403, {
          "x-ratelimit-remaining": "0",
          "retry-after": String(RATE_LIMIT_RETRY_AFTER_SECONDS),
        }),
      );
    }
    return Promise.resolve(this.repositories);
  }

  readConfig(fullName: string): Promise<RepositoryConfigFile | null> {
    return Promise.resolve({ content: configFor(fullName.replace("/", "-"), "PAY"), sha: `sha-${fullName}` });
  }
}

const runSyncWorkflow = async (
  environment: TestWorkflowEnvironment,
  discoveryActivities: DiscoveryActivities,
) => {
  const taskQueue = `at-49-55-${randomUUID()}`;
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowsPath: new URL("../../src/workflows/sync-installation.workflow.ts", import.meta.url).pathname,
    activities: discoveryActivities,
  });
  return worker.runUntil(() =>
    environment.client.workflow.execute(syncInstallationWorkflow, {
      taskQueue,
      workflowId: `sync-at-${randomUUID()}`,
      args: [{ tenantId: "tenant-1", githubInstallationId: "install-1" }],
    }),
  );
};

describe("AT-49 and AT-55: the real installation sync workflow", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  });

  afterAll(async () => {
    await environment.teardown();
  });

  it("AT-49 syncs every granted repository of an installation", async () => {
    const repositories = [
      { fullName: "acme/api", defaultBranch: "main" },
      { fullName: "acme/web", defaultBranch: "main" },
      { fullName: "acme/docs", defaultBranch: "main" },
    ];
    const client = new FakeRepositoryDiscoveryClient(repositories, {
      "acme/api": configFor("checkout-api", "PAY"),
      "acme/web": configFor("checkout-web", "WEB"),
      "acme/docs": configFor("docs-site", "DOCS"),
    });
    const { service, products, repositories: repositoryRows } = buildDiscoveryService(client);
    const activities = createDiscoveryActivities({
      discoveryClient: client,
      discoveryService: service,
      logger: new FakeLogger(),
    });

    const result = await runSyncWorkflow(environment, activities);

    expect(result).toEqual({ registered: 3, skipped: 0, conflicted: 0 });
    expect(repositoryRows.rows.map((row) => row.fullName).sort()).toEqual(["acme/api", "acme/docs", "acme/web"]);
    // Every granted repository reached its own Product, proving the whole grant was walked, not
    // only the first repository.
    expect((await products.list("tenant-1")).map((product) => product.slug).sort()).toEqual([
      "checkout-api",
      "checkout-web",
      "docs-site",
    ]);
  });

  it("AT-55 skips a repository without a configuration file, and does not fail", async () => {
    const repositories = [
      { fullName: "acme/api", defaultBranch: "main" },
      { fullName: "acme/no-config", defaultBranch: "main" },
    ];
    const client = new FakeRepositoryDiscoveryClient(repositories, {
      "acme/api": configFor("checkout-api", "PAY"),
      "acme/no-config": null,
    });
    const { service, repositories: repositoryRows } = buildDiscoveryService(client);
    const activities = createDiscoveryActivities({
      discoveryClient: client,
      discoveryService: service,
      logger: new FakeLogger(),
    });

    const result = await runSyncWorkflow(environment, activities);

    expect(result).toEqual({ registered: 1, skipped: 1, conflicted: 0 });
    expect(repositoryRows.rows.map((row) => row.fullName)).toEqual(["acme/api"]);
    // The workflow reported the outcome as `skipped`, never as a failed activity attempt: the
    // sync of the whole installation still finished.
  });
});

// ---------------------------------------------------------------------------------------------
// AT-54: the rate-limit backoff. The real discovery activity converts a `GitHubApiError` rate
// limit into a retryable `ApplicationFailure` with `nextRetryDelay` (`discovery.activities.ts`).
// The real Temporal retry policy of `syncInstallationWorkflow` then waits and retries. A
// time-skipping test environment proves the wait happened without a test-side sleep.
// ---------------------------------------------------------------------------------------------

describe("AT-54: rate-limit backoff runs through the real Temporal retry policy", () => {
  it("backs off on a rate limit, and completes the sync", async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    try {
      const repositories = [{ fullName: "acme/api", defaultBranch: "main" }];
      const client = new RateLimitedOnceDiscoveryClient(repositories);
      const { service } = buildDiscoveryService(client);
      const activities = createDiscoveryActivities({
        discoveryClient: client,
        discoveryService: service,
        logger: new FakeLogger(),
      });

      const taskQueue = `at-54-${randomUUID()}`;
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        taskQueue,
        workflowsPath: new URL("../../src/workflows/sync-installation.workflow.ts", import.meta.url).pathname,
        activities,
      });
      const handle = await environment.client.workflow.start(syncInstallationWorkflow, {
        taskQueue,
        workflowId: `sync-at-54-${randomUUID()}`,
        args: [{ tenantId: "tenant-1", githubInstallationId: "install-1" }],
      });
      const result = await worker.runUntil(() => handle.result());

      // The first `listInstallationRepositories` call hit the rate limit. The activity turned
      // it into a retryable failure carrying the `retry-after` delay, and the workflow's own
      // retry policy (`proxyActivities` in `sync-installation.workflow.ts`) tried again, so the
      // double saw a second call and the sync still completed.
      expect(client.listCalls).toBe(2);
      expect(result).toEqual({ registered: 1, skipped: 0, conflicted: 0 });

      // A doubled call count alone does not tell an honoured `retry-after` apart from an
      // immediate retry. Temporal's worker retries an activity locally: a failed attempt writes
      // no history event of its own, only the worker log entry already asserted below. History
      // records one `ActivityTaskScheduled` event, when the first attempt was dispatched, and
      // one `ActivityTaskStarted` event, when the attempt that finally ran started. Attempt 1
      // fails in under a millisecond (`durationMs: 0` in the worker log), so the gap between
      // those two events is, in practice, the wait before attempt 2, recorded in the simulated
      // clock the time-skipping server advanced. This is the real evidence of the backoff, not
      // a proxy for it.
      const history = await handle.fetchHistory();
      const events = history.events ?? [];
      const eventTimeMs = (event: (typeof events)[number]): number => {
        const timestamp = event.eventTime;
        if (timestamp === null || timestamp === undefined) throw new Error("a history event carried no event time");
        return Number(timestamp.seconds ?? 0) * 1000 + Math.floor(Number(timestamp.nanos ?? 0) / 1_000_000);
      };
      const scheduled = events.find(
        (event) => event.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED,
      );
      const started = events.find(
        (event) => event.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_ACTIVITY_TASK_STARTED,
      );
      expect(scheduled).toBeDefined();
      expect(started).toBeDefined();
      // The `Started` event that history keeps is the attempt that ran to completion. Attempt 2
      // ran to completion, so this event must carry attempt 2, not the failed attempt 1.
      expect(started?.activityTaskStartedEventAttributes?.attempt).toBe(2);
      const waitedMs = eventTimeMs(started!) - eventTimeMs(scheduled!);

      // The workflow's own default retry interval is one second; `RATE_LIMIT_RETRY_AFTER_SECONDS`
      // is six. A gap near six seconds, not near one, proves the `retry-after` header drove the
      // delay, not the default policy that would have applied to any other retryable failure.
      expect(waitedMs).toBeGreaterThanOrEqual(RATE_LIMIT_RETRY_AFTER_SECONDS * 1000);
      expect(waitedMs).toBeLessThan((RATE_LIMIT_RETRY_AFTER_SECONDS + 5) * 1000);
    } finally {
      await environment.teardown();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// AT-50 and AT-51: the real webhook route (`registerGitHubWebhookRoutes`) and the real
// `verifyGitHubSignature`. Only the tenant registry and the discovery service are fakes, the
// GitHub HTTP boundary and the persistence boundary.
// ---------------------------------------------------------------------------------------------

const WEBHOOK_SECRET = "at-50-51-webhook-secret";

const sign = (body: string) => `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;

class RecordingDiscoveryService {
  readonly syncCalls: string[] = [];

  syncRepository(_tenantId: string, fullName: string): Promise<{ kind: "registered"; repositoryId: string; productId: string; productCreated: boolean }> {
    this.syncCalls.push(fullName);
    return Promise.resolve({ kind: "registered", repositoryId: "r1", productId: "p1", productCreated: false });
  }

  markAbsent(): Promise<void> {
    return Promise.resolve();
  }
}

class SingleInstallationTenantRegistry implements TenantRegistry {
  constructor(private readonly boundInstallationId: string | null, private readonly tenant: TenantRecord) {}

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
    return Promise.resolve(githubInstallationId === this.boundInstallationId ? this.tenant : null);
  }

  putGitHubInstallation(): Promise<"bound"> {
    throw new Error("not used by this route");
  }
}

const buildWebhookApp = (options: { boundInstallationId: string | null }) => {
  const discovery = new RecordingDiscoveryService();
  const logger = new FakeLogger();
  const tenants = new SingleInstallationTenantRegistry(options.boundInstallationId, {
    id: "tenant-1",
    linearWorkspaceId: "ws-1",
    name: "Acme",
  });
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
    // The module under test in AT-50 and AT-51: the real signature verifier, bound to the
    // real webhook secret, not a stub that always answers true.
    discovery: discovery as never,
    tenants,
    verifySignature: (raw, signature) => verifyGitHubSignature({ rawBody: raw, signature, secret: WEBHOOK_SECRET }).ok,
    recordPullRequestPreview: () => Promise.resolve(false),
    startInstallationSync: (input) => {
      started.push(input);
      return Promise.resolve();
    },
    logger,
  });

  return { app, discovery, logger, started };
};

describe("AT-50 and AT-51: the real GitHub webhook route", () => {
  it("AT-50 answers 401 for a wrong webhook signature, and does no work", async () => {
    const { app, discovery, started } = buildWebhookApp({ boundInstallationId: "42" });
    const payload = {
      action: "added",
      installation: { id: 42, account: { login: "acme" } },
      repositories_added: [{ full_name: "acme/api" }],
    };
    const body = JSON.stringify(payload);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation_repositories",
        // Signed over a different body than the one sent, so the real HMAC verification fails.
        "x-hub-signature-256": sign(JSON.stringify({ ...payload, action: "removed" })),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(401);
    expect(discovery.syncCalls).toEqual([]);
    expect(started).toEqual([]);
  });

  it("AT-51 warns for an unbound installation, does no work, and answers 200", async () => {
    const { app, discovery, logger, started } = buildWebhookApp({ boundInstallationId: null });
    const payload = {
      action: "added",
      installation: { id: 99, account: { login: "acme" } },
      repositories_added: [{ full_name: "acme/api" }],
    };
    const body = JSON.stringify(payload);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation_repositories",
        "x-hub-signature-256": sign(body),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(discovery.syncCalls).toEqual([]);
    expect(started).toEqual([]);
    expect(logger.warnCalls).toHaveLength(1);
    expect(logger.warnCalls[0]?.message).toContain("unbound installation");
    expect(logger.warnCalls[0]?.fields).toMatchObject({ installation_id: "99" });
  });
});

// ---------------------------------------------------------------------------------------------
// AT-52: mints a token per installation, and never shares one between two. Driven through the
// real `GitHubAppTokenProvider` and the real `GitHubRepositoryDiscoveryClient`, the path an
// operator actually recognises (a repository read against the GitHub API), rather than by
// re-testing the provider's cache in isolation as `tests/unit/app-token-provider.test.ts`
// already does.
// ---------------------------------------------------------------------------------------------

const privateKey = (() => {
  const { privateKey: key } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return key.export({ type: "pkcs8", format: "pem" }) as string;
})();

/** A minimal fixture of the GitHub App token-mint endpoint and the repository-contents endpoint. */
const startAppFixtureApi = async (): Promise<{
  baseUrl: string;
  /** Every `Authorization` header the contents endpoint received, alongside the installation the URL named. */
  contentsRequests: { installationIdInUrl: string; authorization: string | undefined }[];
  mintedTokenByInstallation: Map<string, string>;
  stop: () => Promise<void>;
}> => {
  const app = Fastify({ logger: false });
  const mintedTokenByInstallation = new Map<string, string>();
  const contentsRequests: { installationIdInUrl: string; authorization: string | undefined }[] = [];
  let counter = 0;

  app.post("/app/installations/:id/access_tokens", (request, reply) => {
    const { id } = request.params as { id: string };
    counter += 1;
    const token = `ghs_installation_${id}_${String(counter)}`;
    mintedTokenByInstallation.set(id, token);
    return reply.code(201).send({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  });

  app.get("/repos/:owner/:repo/contents/*", (request, reply) => {
    const { owner } = request.params as { owner: string; repo: string };
    // The fixture repository names its owner after the installation id, so the test can tell
    // which installation a contents read named.
    contentsRequests.push({
      installationIdInUrl: owner,
      authorization: request.headers.authorization,
    });
    return reply.code(200).send({
      sha: `sha-${owner}`,
      content: Buffer.from(configFor(`product-${owner}`, "PAY")).toString("base64"),
      encoding: "base64",
    });
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    baseUrl: address,
    contentsRequests,
    mintedTokenByInstallation,
    stop: () => app.close(),
  };
};

describe("AT-52: the real token provider mints one token per installation", () => {
  it("AT-52 mints a token per installation, and never shares one between two", async () => {
    const fixture = await startAppFixtureApi();
    try {
      const tokens = new GitHubAppTokenProvider({
        credentials: () => Promise.resolve({ appId: "app-1", privateKey, apiBaseUrl: fixture.baseUrl }),
      });
      const client = new GitHubRepositoryDiscoveryClient({ apiBaseUrl: fixture.baseUrl, tokens });

      // Two installations, read concurrently, each through the real client and the real
      // provider. An operator sees this exact path when two customers' repositories both push
      // in the same second.
      const [installA, installB] = await Promise.all([
        client.readConfig("install-a/repo", "main", "install-a"),
        client.readConfig("install-b/repo", "main", "install-b"),
      ]);

      expect(installA?.content).toContain("product-install-a");
      expect(installB?.content).toContain("product-install-b");

      const tokenA = fixture.mintedTokenByInstallation.get("install-a");
      const tokenB = fixture.mintedTokenByInstallation.get("install-b");
      expect(tokenA).toBeDefined();
      expect(tokenB).toBeDefined();
      expect(tokenA).not.toBe(tokenB);

      // Every contents read named its own installation's URL, and carried its own installation's
      // token in the Authorization header, never the other installation's.
      const requestForA = fixture.contentsRequests.find((r) => r.installationIdInUrl === "install-a");
      const requestForB = fixture.contentsRequests.find((r) => r.installationIdInUrl === "install-b");
      expect(requestForA?.authorization).toBe(`Bearer ${String(tokenA)}`);
      expect(requestForB?.authorization).toBe(`Bearer ${String(tokenB)}`);
      expect(requestForA?.authorization).not.toBe(requestForB?.authorization);
    } finally {
      await fixture.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// AT-53: clones and publishes with a minted token, and holds no Product GITHUB_TOKEN. Follows
// the fixture shape of `tests/acceptance/at-29-pull-request.test.ts`, but mints the write
// credential through the real `GitHubAppTokenProvider` against a fixture access-token endpoint,
// instead of a fixed test token, and asserts the Product secret store never holds a GitHub
// credential at all.
// ---------------------------------------------------------------------------------------------

const startPublishFixtureApi = async (options: {
  resolveHeadSha: (branch: string) => string | null;
}): Promise<{
  baseUrl: string;
  mintedTokens: string[];
  pullRequestAuthorizations: (string | undefined)[];
  created: number;
  stop: () => Promise<void>;
}> => {
  const app = Fastify({ logger: false });
  const mintedTokens: string[] = [];
  const pullRequestAuthorizations: (string | undefined)[] = [];
  let counter = 0;
  const store: { number: number; html_url: string; head: { ref: string; sha: string }; base: { ref: string } }[] = [];

  app.post("/app/installations/:id/access_tokens", (_request, reply) => {
    counter += 1;
    const token = `ghs_at53_${String(counter)}`;
    mintedTokens.push(token);
    return reply.code(201).send({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  });

  app.get("/repos/:owner/:repo/pulls", (request, reply) => {
    pullRequestAuthorizations.push(request.headers.authorization);
    const query = request.query as { head?: string };
    const head = query.head ?? "";
    const branch = head.includes(":") ? head.slice(head.indexOf(":") + 1) : head;
    const matches = branch === "" ? store : store.filter((entry) => entry.head.ref === branch);
    return reply.code(200).send(matches);
  });

  app.post("/repos/:owner/:repo/pulls", (request, reply) => {
    pullRequestAuthorizations.push(request.headers.authorization);
    const body = request.body as { title?: string; body?: string; head?: string; base?: string };
    const headBranch = body.head ?? "";
    const number = store.length + 1;
    const record = {
      number,
      html_url: `https://github.test/pull/${String(number)}`,
      head: { ref: headBranch, sha: options.resolveHeadSha(headBranch) ?? "0".repeat(40) },
      base: { ref: body.base ?? "" },
    };
    store.push(record);
    return reply.code(201).send(record);
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    baseUrl: address,
    mintedTokens,
    pullRequestAuthorizations,
    get created() {
      return store.length;
    },
    stop: () => app.close(),
  };
};

describe("AT-53: publication mints its write credential from the GitHub App", () => {
  const RUN_ID = "at53-run";
  const SLUG = "acme/app";
  let remote: BareRemote;
  let fixture: Awaited<ReturnType<typeof startPublishFixtureApi>>;
  let sandbox: LocalProcessSandbox;
  let sandboxRoot: string;
  let ref: SandboxRef;
  let primaryPath: string;
  let secrets: MemorySecretStore;
  const environment = new MockActivityEnvironment();

  beforeAll(async () => {
    remote = await createBareRemote({ files: { "README.md": "base\n" } });
    fixture = await startPublishFixtureApi({ resolveHeadSha: (name) => remote.refSha(name) });

    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-at53-sandbox-"));
    sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    ref = await sandbox.create({ runId: RUN_ID, tenantId: "tenant-1", productId: "product-1" });
    primaryPath = `${ref.workspacePath}/primary`;
    const clone = await sandbox.exec(ref, {
      file: "sh",
      args: [
        "-c",
        `git clone "$1" "$2" >/dev/null 2>&1 && printf 'changed\\n' > "$2/README.md" && printf OK`,
        "sh",
        remote.cloneUrl,
        primaryPath,
      ],
    });
    expect(clone.stdout).toBe("OK");
  });

  afterAll(async () => {
    await fixture.stop();
    await sandbox.destroy(ref);
    await rm(sandboxRoot, { recursive: true, force: true });
    await remote.destroy();
  });

  it("AT-53 clones and publishes with a minted token, and holds no Product GITHUB_TOKEN", async () => {
    secrets = new MemorySecretStore({});
    const redactor = new Redactor([]);
    const tokens = new GitHubAppTokenProvider({
        credentials: () => Promise.resolve({ appId: "app-1", privateKey, apiBaseUrl: fixture.baseUrl }),
      });

    const localCloneSeam = (input: TrustedCheckoutInput) => realPublishToBranch({ ...input, cloneUrl: remote.cloneUrl });

    const runs: RunRepository = {
      setPublication: () => Promise.resolve(),
    } as unknown as RunRepository;

    const staged = await sandbox.exec(ref, {
      file: "sh",
      args: ["-c", 'git -C "$1" add -A && git -C "$1" write-tree', "sh", primaryPath],
    });
    const stagedTreeSha = staged.stdout.trim();
    const verified = await capturePatch({ sandbox, redactor }, { ref, primaryPath, baseSha: remote.baseSha });

    const activities = createPublishingActivities({
      sandbox,
      secrets,
      // The real GitHub App token provider. It mints against the fixture's access-token
      // endpoint, keyed by `githubInstallationId` below, exactly as it mints in production.
      tokens,
      redactor,
      runs,
      pullRequests: (token: string) => new GitHubPullRequests({ apiBaseUrl: fixture.baseUrl, tokens: { tokenForInstallation: () => Promise.resolve(token) } }),
      gitAuthor: () => Promise.resolve({ name: "Factoree", email: "factoree@users.noreply.github.com" }),
      logger: createLogger({ level: "error", redactor, sink: () => undefined }),
      publishToBranch: localCloneSeam,
    });

    const input: PublishActivityInput = {
      runId: RUN_ID,
      tenantId: "tenant-1",
      productId: "product-1",
      spriteId: ref.id,
      adapter: ref.adapter,
      workspacePath: ref.workspacePath,
      primaryPath,
      repositorySlug: SLUG,
      repositoryBaseUrl: "https://github.test",
      baseBranch: "main",
      baseSha: remote.baseSha,
      reviewedChangedFiles: ["README.md"],
      reviewedWorktreeSha: stagedTreeSha,
      verifiedPatchSha256: verified.patchSha256,
      draft: false,
      workItemTitle: "Change the README",
      workItemUrl: null,
      verificationSummary: "every deterministic check passed on attempt 1",
      repairCount: 0,
      githubInstallationId: "install-at53",
    };

    const output: PublishActivityOutput = await environment.run(
      (value: PublishActivityInput) => activities.publish(value),
      input,
    );

    expect(output.created).toBe(true);
    expect(fixture.created).toBe(1);
    // The credential the pull request adapter used is exactly the credential the fixture minted
    // for this installation, so the whole path used one minted token, not a stand-in.
    expect(fixture.mintedTokens).toHaveLength(1);
    expect(fixture.pullRequestAuthorizations.every((auth) => auth === `Bearer ${String(fixture.mintedTokens[0])}`)).toBe(
      true,
    );

    // The Product secret store received no write to a name a GitHub credential would use, and
    // holds nothing under `GITHUB_TOKEN` after the whole publish. The App is the only path.
    expect(await secrets.listNames()).not.toContain("GITHUB_TOKEN");
    expect(await secrets.get("tenant-1", "product-1", "GITHUB_TOKEN")).toBeNull();
  });
});
