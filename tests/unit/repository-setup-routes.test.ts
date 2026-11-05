import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerRepositorySetupRoutes } from "~/http/admin/repository-setup.routes.js";
import type { RepositoryRecord } from "~/domain/products/repository-registry.js";
import type { RepositorySetupRecord, RepositorySetupStore } from "~/domain/setup/repository-setup.js";

const repository = (fullName: string, productId: string): RepositoryRecord =>
  ({ fullName, productId, tenantId: "tenant-1", absentSince: null, needsSetupReason: null }) as RepositoryRecord;

const build = () => {
  const rows: RepositorySetupRecord[] = [];
  const started: string[] = [];
  const setups: RepositorySetupStore = {
    create: (input) => {
      const row = { ...input, id: `setup-${rows.length + 1}`, status: "queued", pullRequestUrl: null, report: null, failureMessage: null, sessionUsage: null, createdAt: new Date(rows.length), endedAt: null } as RepositorySetupRecord;
      rows.unshift(row);
      return Promise.resolve(row);
    },
    findById: (id) => Promise.resolve(rows.find((row) => row.id === id) ?? null),
    latestByProduct: () => Promise.resolve(rows.filter((row, index) => rows.findIndex((other) => other.repositoryFullName === row.repositoryFullName) === index)),
    update: () => Promise.resolve(),
  };
  const app = Fastify();
  registerRepositorySetupRoutes(app, {
    products: { findById: () => Promise.resolve({ id: "product-1" }) } as never,
    tenants: { findByWorkspace: () => Promise.resolve({ id: "tenant-1", linearWorkspaceId: "w", name: "W" }) } as never,
    setups,
    registeredRepositories: () => Promise.resolve([repository("acme/c-dash", "product-1"), repository("acme/billing", "product-2")]),
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
  return { app, started };
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
});
