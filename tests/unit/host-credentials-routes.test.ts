import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerHostCredentialRoutes } from "~/http/admin/host-credentials.routes.js";
import type { HostCredential, HostCredentialStore } from "~/domain/products/host-credentials.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { PutSecretOptions, SecretStore } from "~/domain/products/secret-store.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";

const TENANT = { id: "t1", linearWorkspaceId: "ws-1", name: "Acme" };

const setup = (options: { registry?: (host: string) => Promise<{ realmHost: string | null; realmPath: string | null }>; installed?: string[] } = {}) => {
  let rows: HostCredential[] = [];
  const secrets = new Map<string, { value: string; kind: string }>();
  const store: HostCredentialStore = {
    list: () => Promise.resolve(rows),
    replace: (_tenant, _product, next) => {
      rows = [...next];
      return Promise.resolve();
    },
  };
  const secretStore = {
    put: (_t: string, _p: string, name: string, value: string, put?: PutSecretOptions) => {
      secrets.set(name, { value, kind: put?.kind ?? "test" });
      return Promise.resolve();
    },
    get: (_t: string, _p: string, name: string) => Promise.resolve(secrets.get(name)?.value ?? null),
    listNames: () => Promise.resolve([...secrets.keys()]),
    list: () => Promise.resolve([]),
    remove: (_t: string, _p: string, name: string) => Promise.resolve(secrets.delete(name)),
  } satisfies SecretStore;
  let buildAheads = 0;
  const app = Fastify();
  registerHostCredentialRoutes(app, {
    products: { findById: () => Promise.resolve({ id: "p1" }) } as unknown as ProductRegistry,
    tenants: { findByWorkspace: (id: string) => Promise.resolve(id === "ws-1" ? TENANT : null) } as unknown as TenantRegistry,
    secrets: secretStore,
    credentials: store,
    checkRegistryLogin: options.registry ?? (() => Promise.resolve({ realmHost: "ghcr.io", realmPath: "/token" })),
    installations: () => Promise.resolve(["9"]),
    listInstallationRepositories: () => Promise.resolve((options.installed ?? ["acme/app", "acme/lib"]).map((fullName) => ({ fullName }))),
    buildAhead: {
      afterAllowListChange: () => {
        buildAheads += 1;
        return Promise.resolve();
      },
    },
  });
  const put = (credentials: unknown[]) =>
    app.inject({ method: "PUT", url: "/admin/products/p1/host-credentials?linearWorkspaceId=ws-1", payload: { credentials } });
  return { app, put, secrets, rows: () => rows, buildAheads: () => buildAheads };
};

describe("host credential routes (docs/specs/host-credentials.md)", () => {
  it("stores the secret, its Basic form and the token service, and requests a build-ahead", async () => {
    const { put, secrets, rows, buildAheads } = setup();
    const response = await put([{ kind: "registry", host: "ghcr.io", username: "bot", secret: "pat", redirectHosts: ["pkg-containers.githubusercontent.com"] }]);
    expect(response.statusCode).toBe(200);
    expect(rows()).toMatchObject([{ kind: "registry", host: "ghcr.io", realmHost: "ghcr.io", realmPath: "/token" }]);
    expect(secrets.get("host:ghcr.io")).toEqual({ value: "pat", kind: "host_credential" });
    expect(secrets.get("host:ghcr.io:basic")?.value).toBe(`Basic ${Buffer.from("bot:pat").toString("base64")}`);
    expect(buildAheads()).toBe(1);
    expect(response.json()).toMatchObject({ credentials: [{ host: "ghcr.io", hasSecret: true }] });
  });

  it("answers 422 to a failed registry login, and the product keeps its old list", async () => {
    let fail = false;
    const { put, secrets, rows } = setup({
      registry: () => (fail ? Promise.reject(new Error("ghcr.io answered 401")) : Promise.resolve({ realmHost: null, realmPath: null })),
    });
    await put([{ kind: "header", host: "npm.pkg.github.com", headerName: "Authorization", secret: "Bearer a" }]);
    fail = true;
    const response = await put([
      { kind: "header", host: "npm.pkg.github.com", headerName: "Authorization" },
      { kind: "registry", host: "ghcr.io", username: "bot", secret: "wrong" },
    ]);
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: string }>().error).toContain("401");
    expect(rows().map((row) => row.host)).toEqual(["npm.pkg.github.com"]);
    expect(secrets.has("host:ghcr.io")).toBe(false);
  });

  it("answers 422 to a github repository outside the installation", async () => {
    const { put, rows } = setup({ installed: ["acme/app"] });
    const response = await put([{ kind: "github", host: "github.com", repositories: ["acme/lib"] }]);
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: string }>().error).toContain("acme/lib");
    expect(rows()).toEqual([]);
  });

  it("keeps a stored secret when the save leaves it out, and deletes it when the credential goes", async () => {
    const { put, secrets } = setup();
    await put([{ kind: "header", host: "npm.pkg.github.com", headerName: "Authorization", secret: "Bearer a" }]);
    expect((await put([{ kind: "header", host: "npm.pkg.github.com", headerName: "X-Token" }])).statusCode).toBe(200);
    expect(secrets.get("host:npm.pkg.github.com")?.value).toBe("Bearer a");
    expect((await put([])).statusCode).toBe(200);
    expect(secrets.has("host:npm.pkg.github.com")).toBe(false);
  });
});
