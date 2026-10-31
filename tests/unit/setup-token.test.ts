import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerSetupRoutes, type SetupRouteDependencies } from "~/http/setup/setup.routes.js";
import { issueSetupToken, readFlowState, signFlowState } from "~/http/setup/setup-token.js";
import type { InstallSettings, InstallSettingsStore } from "~/domain/settings/install-settings.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";

const MASTER_KEY = "e".repeat(64);

/** The install settings row in memory, with the fields setup reads. */
class MemorySettings implements InstallSettingsStore {
  hash: string | null = null;
  completedAt: Date | null = null;

  read(): Promise<InstallSettings> {
    return Promise.resolve({
      github: {
        appId: null,
        appSlug: null,
        clientId: null,
        clientSecret: null,
        privateKey: null,
        webhookSecret: null,
        baseUrl: "https://github.com",
        apiBaseUrl: "https://api.github.com",
      },
      linear: { clientId: null, clientSecret: null, webhookSecret: null },
      sandbox: {
        provider: null,
        url: null,
        apiKey: null,
        image: null,
        registryUsername: null,
        registryToken: null,
        maxLive: null,
      },
      gitAuthor: { name: "Factoree", email: "factoree@users.noreply.github.com" },
      operatorTenantId: null,
      setupCompletedAt: this.completedAt,
    });
  }
  update(): Promise<InstallSettings> {
    return this.read();
  }
  setupTokenHash(): Promise<string | null> {
    return Promise.resolve(this.hash);
  }
  storeSetupTokenHash(hash: string): Promise<void> {
    this.hash = hash;
    return Promise.resolve();
  }
  completeSetup(at: Date): Promise<void> {
    this.completedAt = at;
    this.hash = null;
    return Promise.resolve();
  }
}

const unused = new Proxy({}, { get: () => () => Promise.reject(new Error("unused")) }) as never;

const server = (settings: InstallSettingsStore) => {
  const app = Fastify();
  const dependencies: SetupRouteDependencies = {
    // Status reads the stored Linear installations while no setup workspace exists. None exist here.
    prisma: { tenant: { findMany: () => Promise.resolve([]) } } as never,
    settings,
    tenants: unused,
    products: unused,
    secrets: unused,
    linearTeams: unused,
    publicUrl: "https://factoree.example.com",
    masterKey: MASTER_KEY,
    localSandboxAllowed: false,
    logger: createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
    github: unused,
    linear: unused,
    startInstallationSync: unused,
  };
  registerSetupRoutes(app, dependencies);
  return app;
};

const status = (app: ReturnType<typeof server>, token?: string) =>
  app.inject({
    method: "GET",
    url: "/api/setup/status",
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

describe("the setup token", () => {
  it("guards every setup call until setup ends, and only the token of the latest start works", async () => {
    const settings = new MemorySettings();
    const app = server(settings);
    const first = await issueSetupToken(settings);
    expect(first).not.toBeNull();
    // Only the hash is stored.
    expect(settings.hash).not.toContain(first);

    expect((await status(app)).statusCode).toBe(401);
    expect((await status(app, "not-the-token")).statusCode).toBe(401);
    expect((await status(app, first ?? "")).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/setup/state" })).json()).toEqual({ completed: false });

    // A restart before setup ends issues a new token, and the old one stops working.
    const second = await issueSetupToken(settings);
    expect((await status(app, first ?? "")).statusCode).toBe(401);
    expect((await status(app, second ?? "")).statusCode).toBe(200);

    await settings.completeSetup(new Date());
    expect((await status(app, second ?? "")).statusCode).toBe(410);
    expect(await issueSetupToken(settings)).toBeNull();
    expect((await app.inject({ method: "GET", url: "/api/setup/state" })).json()).toEqual({ completed: true });
  });

  it("refuses to finish setup while a step is open", async () => {
    const settings = new MemorySettings();
    const app = server(settings);
    const token = (await issueSetupToken(settings)) ?? "";
    const response = await app.inject({
      method: "POST",
      url: "/api/setup/complete",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(409);
    expect(settings.completedAt).toBeNull();
  });
});

describe("the state of a GitHub or Linear redirect", () => {
  it("carries its purpose, and refuses a forged, another key's, or an expired state", () => {
    const state = signFlowState(MASTER_KEY, "setup", 1_000);
    expect(readFlowState(MASTER_KEY, state, 2_000)).toBe("setup");

    const [payload, mac] = state.split(".");
    const forged = `${Buffer.from(JSON.stringify({ purpose: "workspace", exp: 10_000_000, nonce: "x" })).toString("base64url")}.${mac}`;
    expect(readFlowState(MASTER_KEY, forged, 2_000)).toBeNull();
    expect(readFlowState("f".repeat(64), state, 2_000)).toBeNull();
    expect(readFlowState(MASTER_KEY, `${payload}`, 2_000)).toBeNull();
    expect(readFlowState(MASTER_KEY, state, 1_000 + 31 * 60_000)).toBeNull();
  });
});
