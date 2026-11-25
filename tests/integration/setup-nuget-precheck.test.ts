import { describe, expect, it } from "vitest";
import { createSetupActivities, type SetupActivityDependencies } from "~/activities/setup.activities.js";
import type { HostCredential } from "~/domain/products/host-credentials.js";
import { renderSetupReport } from "~/domain/setup/setup-report.js";
import { PrismaRepositorySetupStore } from "~/persistence/prisma/repository-setup.prisma.js";
import { PrismaRunEventStore } from "~/persistence/prisma/run-event.prisma.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { installNugetWorld, mirrorCredential, PRIVATE_FEED_CONFIG, project, type NugetWorld } from "../support/fake-nuget.js";
import { withDatabase, seedTenantProjectAndRun } from "./support/database.js";

const REPOSITORY = "acme/anthology";

const activitiesOf = (prisma: Parameters<Parameters<typeof withDatabase>[0]>[0], productId: string, world: NugetWorld, credentials: HostCredential[]) => {
  const sandbox = new FakeSandbox();
  installNugetWorld(sandbox, world, "/workspace/primary", (command) =>
    command.file === "git" && command.args.includes("rev-parse") ? { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" } : null,
  );
  const redactor = new Redactor();
  const logger = createLogger({ level: "error", redactor });
  const hosts = credentials.flatMap((credential) => [credential.host, ...credential.redirectHosts]);
  const dependencies = {
    setups: new PrismaRepositorySetupStore(prisma),
    events: { store: new PrismaRunEventStore(prisma), redactor, logger },
    products: { findById: () => Promise.resolve({ id: productId, slug: "anthology", linearTeamKey: "FAC", allowedDomains: [], sandboxRetentionHours: 24, defaultRunner: "opencode", model: null, runners: {}, models: {}, effort: {} }) },
    sandbox,
    runners: { get: () => ({ run: () => Promise.reject(new Error("a failed pre-check starts no session")) }) },
    secrets: { list: () => Promise.resolve([]), get: () => Promise.resolve(null), listNames: () => Promise.resolve([]) },
    tokens: { tokenForInstallation: () => Promise.resolve("ghs_token") },
    discoveryClient: { listInstallationRepositories: () => Promise.resolve([{ fullName: REPOSITORY, defaultBranch: "main" }]) },
    repositoryFiles: { headSha: () => Promise.resolve("b".repeat(40)), readFile: (_name: string, path: string) => Promise.resolve(world.files[path] ?? null) },
    hostCredentials: () => Promise.resolve({ credentials, hosts, bindings: credentials.map((credential) => ({ name: credential.host, host: credential.host, header: "Authorization", value: "Basic c2VjcmV0", methods: ["GET", "HEAD"] })), refreshes: false }),
    credentialHosts: () => Promise.resolve(hosts),
    browser: { name: "unused" },
    previewProbe: () => Promise.resolve(null),
    pullRequests: () => ({}),
    gitAuthor: () => Promise.resolve({ name: "Factoree", email: "f@example.test" }),
    repositoryBaseUrl: () => Promise.resolve("https://github.com"),
    redactor,
    logger,
  } as unknown as SetupActivityDependencies;
  return createSetupActivities(dependencies);
};

/** The workflow's order, up to the session. */
const precheck = async (activities: ReturnType<typeof createSetupActivities>, setupId: string) => {
  const read = await activities.prepareSetup({ setupId, temporalRunId: `run-${setupId}` });
  if (read.kind !== "precheck") throw new Error(`no pre-check: ${read.kind}`);
  return activities.precheckNugetFeeds({ setupId, prepared: read });
};

describe("the NuGet pre-check against PostgreSQL (docs/specs/nuget-private-feed-mapping.md)", () => {
  it("stores the failed report with its evidence and a run event, and never skips the next setup", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, productId } = await seedTenantProjectAndRun(prisma);
      const store = new PrismaRepositorySetupStore(prisma);
      const world: NugetWorld = {
        files: { "NuGet.config": PRIVATE_FEED_CONFIG, "src/Api/Api.csproj": project({ "Frontiers.Core": "3.1.0", "Frontiers.Missing": "2.0.0" }) },
        mirror: { "frontiers.core": ["3.1.0"] },
      };
      const activities = activitiesOf(prisma, productId, world, [mirrorCredential()]);

      const first = await store.create({ tenantId, productId, repositoryFullName: REPOSITORY, githubInstallationId: "42", workflowId: "w-1" });
      const outcome = await precheck(activities, first.id);
      expect(outcome.kind).toBe("failed");
      await activities.finishSetup({ setupId: first.id, status: "failed", pullRequestUrl: null, failureMessage: outcome.kind === "failed" ? outcome.reason : null });

      const stored = await store.findById(first.id);
      expect(stored?.status).toBe("failed");
      expect(stored?.inputKey).toMatch(/^[0-9a-f]{64}$/);
      expect(stored?.report?.nuget?.packages.find((entry) => entry.id === "Frontiers.Missing")).toMatchObject({ status: "not_found", projects: ["src/Api/Api.csproj"] });
      const text = renderSetupReport(stored!.report!);
      expect(text).toContain("The NuGet pre-check failed, so Factoree started no setup agent and proved nothing.");
      expect(text).toContain("mirror these packages to https://github.com/orgs/frontiersin/packages: Frontiers.Missing 2.0.0");

      const events = await new PrismaRunEventStore(prisma).list({ tenantId, subject: { setupId: first.id }, limit: 10 });
      expect(events.items).toHaveLength(1);
      expect(events.items[0]).toMatchObject({ kind: "command_failed", stage: "setup", detail: { step: "setup_precheck:nuget" } });

      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await store.create({ tenantId, productId, repositoryFullName: REPOSITORY, githubInstallationId: "42", workflowId: "w-2" });
      expect((await precheck(activities, second.id)).kind).toBe("failed");
      expect((await store.findById(second.id))?.inputKey).toBe(stored?.inputKey);
      expect((await store.findById(second.id))?.skippedFromSetupId).toBeNull();
    });
  });

  it("runs and passes an unchanged repository once the package is mirrored or the credential is added", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, productId } = await seedTenantProjectAndRun(prisma);
      const store = new PrismaRepositorySetupStore(prisma);
      const world: NugetWorld = {
        files: { "NuGet.config": PRIVATE_FEED_CONFIG, "src/Api/Api.csproj": project({ "Terminology.Provider": "0.2.6.0" }) },
        mirror: {},
      };
      const failOnce = async (activities: ReturnType<typeof createSetupActivities>, workflowId: string): Promise<string | null | undefined> => {
        const setup = await store.create({ tenantId, productId, repositoryFullName: REPOSITORY, githubInstallationId: "42", workflowId });
        const outcome = await precheck(activities, setup.id);
        expect(outcome.kind).toBe("failed");
        await activities.finishSetup({ setupId: setup.id, status: "failed", pullRequestUrl: null, failureMessage: outcome.kind === "failed" ? outcome.reason : null });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return (await store.findById(setup.id))?.inputKey;
      };

      const missingKey = await failOnce(activitiesOf(prisma, productId, world, [mirrorCredential()]), "w-missing");
      world.mirror = { "terminology.provider": ["0.2.6"] };
      const mirrored = await store.create({ tenantId, productId, repositoryFullName: REPOSITORY, githubInstallationId: "42", workflowId: "w-mirrored" });
      const ran = await precheck(activitiesOf(prisma, productId, world, [mirrorCredential()]), mirrored.id);
      expect(ran).toMatchObject({ kind: "run", nuget: { outcome: "passed", mirroredIds: ["Terminology.Provider"] } });
      expect((await store.findById(mirrored.id))?.inputKey).not.toBe(missingKey);
      expect((await store.findById(mirrored.id))?.skippedFromSetupId).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 5));

      const noCredentialKey = await failOnce(activitiesOf(prisma, productId, world, []), "w-no-credential");
      const credentialed = await store.create({ tenantId, productId, repositoryFullName: REPOSITORY, githubInstallationId: "42", workflowId: "w-credential" });
      const again = await precheck(activitiesOf(prisma, productId, world, [mirrorCredential()]), credentialed.id);
      expect(again).toMatchObject({ kind: "run", nuget: { outcome: "passed", credential: "present" } });
      expect((await store.findById(credentialed.id))?.inputKey).not.toBe(noCredentialKey);
      expect((await store.findById(credentialed.id))?.skippedFromSetupId).toBeNull();
    });
  });
});
