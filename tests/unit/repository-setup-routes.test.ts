import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerRepositorySetupRoutes } from "~/http/admin/repository-setup.routes.js";
import type { RepositoryRecord } from "~/domain/products/repository-registry.js";
import type { RepositorySetupRecord, RepositorySetupStore } from "~/domain/setup/repository-setup.js";
import { MemoryRunEventStore } from "../support/memory-run-event-store.js";

const repository = (fullName: string, productId: string, membership: RepositoryRecord["membership"] = "accepted"): RepositoryRecord =>
  ({
    id: `id-${fullName}`,
    fullName,
    productId,
    tenantId: "tenant-1",
    absentSince: null,
    needsSetupReason: null,
    membership,
    membershipDecidedBy: null,
    membershipDecidedAt: null,
    requestedSecretNames: [],
    configSha: "sha",
    defaultBranch: "main",
    linearProjects: [],
    discoveredAt: new Date(0),
    lastSeenAt: new Date(0),
    githubInstallationId: "42",
  }) satisfies RepositoryRecord;

const build = (registered: RepositoryRecord[] = [repository("acme/c-dash", "product-1"), repository("acme/billing", "product-2")]) => {
  const rows: RepositorySetupRecord[] = [];
  const decisions: Array<{ repositoryId: string; membership: string }> = [];
  const accepted: string[] = [];
  const started: string[] = [];
  const setups: RepositorySetupStore = {
    create: (input) => {
      const row = { ...input, id: `setup-${rows.length + 1}`, status: "queued", pullRequestUrl: null, report: null, failureMessage: null, sessionUsage: null, createdAt: new Date(rows.length), endedAt: null } as RepositorySetupRecord;
      rows.unshift(row);
      return Promise.resolve(row);
    },
    findById: (id) => Promise.resolve(rows.find((row) => row.id === id) ?? null),
    latestByProduct: () => Promise.resolve(rows.filter((row, index) => rows.findIndex((other) => other.repositoryFullName === row.repositoryFullName) === index)),
    previousWithReport: () => Promise.resolve(null),
    latestOpenPullRequest: () => Promise.resolve(null),
    latestEnded: () => Promise.resolve(null),
    listForRepository: () => Promise.resolve([]),
    update: () => Promise.resolve(),
  };
  const app = Fastify();
  // The admin guard sets the principal in the server. Here one admin calls every route.
  app.addHook("onRequest", (request, _reply, done) => {
    request.principal = { userId: "user-1", apiKeyId: null, memberships: [], operatorAdmin: false };
    done();
  });
  registerRepositorySetupRoutes(app, {
    products: { findById: () => Promise.resolve({ id: "product-1" }) } as never,
    tenants: { findByWorkspace: () => Promise.resolve({ id: "tenant-1", linearWorkspaceId: "w", name: "W" }) } as never,
    setups,
    events: new MemoryRunEventStore(),
    registeredRepositories: () => Promise.resolve(registered),
    repositories: {
      decideMembership: (input) => {
        decisions.push({ repositoryId: input.repositoryId, membership: input.membership });
        const row = registered.find((candidate) => candidate.id === input.repositoryId && candidate.productId === input.productId);
        return Promise.resolve(row === undefined ? null : { ...row, membership: input.membership, membershipDecidedBy: input.decidedBy, membershipDecidedAt: input.at });
      },
    },
    buildAhead: {
      afterAccept: (_tenantId, fullName) => {
        accepted.push(fullName);
        return Promise.resolve();
      },
    },
    userName: () => Promise.resolve("Ada"),
    installations: () => Promise.resolve(["42"]),
    listInstallationRepositories: () =>
      Promise.resolve([
        { fullName: "acme/anthology", defaultBranch: "main" },
        { fullName: "acme/billing", defaultBranch: "main" },
        { fullName: "acme/c-dash", defaultBranch: "main" },
      ]),
    startSetup: ({ setupId }) => {
      started.push(setupId);
      return Promise.resolve(true);
    },
  });
  return { app, started, decisions, accepted };
};

describe("repository setup routes (repository-setup-and-services.md)", () => {
  it("lists this product's repositories and the ones no product owns", async () => {
    const { app } = build();
    const response = await app.inject({ method: "GET", url: "/admin/products/product-1/repository-setups?linearWorkspaceId=w" });
    expect(response.json<Array<{ fullName: string; registered: boolean }>>().map((row) => [row.fullName, row.registered])).toEqual([
      ["acme/anthology", false],
      ["acme/c-dash", true],
    ]);
  });

  it("starts one setup per repository, and a second start returns the running one", async () => {
    const { app, started } = build();
    const body = { linearWorkspaceId: "w", repositories: ["acme/anthology"] };
    const first = await app.inject({ method: "POST", url: "/admin/products/product-1/repository-setups", payload: body });
    const second = await app.inject({ method: "POST", url: "/admin/products/product-1/repository-setups", payload: body });
    expect(first.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());
    expect(started).toEqual(["setup-1"]);
  });

  it("refuses a repository another product owns", async () => {
    const { app } = build();
    const response = await app.inject({
      method: "POST",
      url: "/admin/products/product-1/repository-setups",
      payload: { linearWorkspaceId: "w", repositories: ["acme/billing"] },
    });
    expect(response.statusCode).toBe(422);
  });

  // docs/specs/repository-membership.md.
  it("offers a repository whose claim on another product no admin accepted", async () => {
    const { app } = build([repository("acme/billing", "product-2", "pending")]);
    const response = await app.inject({ method: "GET", url: "/admin/products/product-1/repository-setups?linearWorkspaceId=w" });
    expect(response.json<Array<{ fullName: string; registered: boolean }>>().map((row) => [row.fullName, row.registered])).toEqual([
      ["acme/anthology", false],
      ["acme/billing", false],
      ["acme/c-dash", false],
    ]);
  });

  it("accepts a pending claim and starts its build-ahead, and refuses a repository of another product", async () => {
    const { app, accepted } = build([repository("acme/c-dash", "product-1", "pending"), repository("acme/billing", "product-2", "pending")]);
    const ok = await app.inject({
      method: "POST",
      url: "/admin/products/product-1/repositories/id-acme%2Fc-dash/membership",
      payload: { linearWorkspaceId: "w", decision: "accept" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ state: "accepted", decidedBy: "Ada" });
    expect(accepted).toEqual(["acme/c-dash"]);
    const other = await app.inject({
      method: "POST",
      url: "/admin/products/product-1/repositories/id-acme%2Fbilling/membership",
      payload: { linearWorkspaceId: "w", decision: "accept" },
    });
    expect(other.statusCode).toBe(404);
  });

  it("accepts the pending claim of a repository when an admin starts its setup", async () => {
    const { app, decisions } = build([repository("acme/c-dash", "product-1", "pending")]);
    await app.inject({
      method: "POST",
      url: "/admin/products/product-1/repository-setups",
      payload: { linearWorkspaceId: "w", repositories: ["acme/c-dash"] },
    });
    expect(decisions).toEqual([{ repositoryId: "id-acme/c-dash", membership: "accepted" }]);
  });
});
