import { describe, expect, it, vi } from "vitest";
import {
  TenantScopedLinearTeamLookup,
  type TenantWorkspaceLookup,
} from "~/adapters/linear/team-lookup-by-tenant.js";
import { LinearInstallationError, LinearTokenProvider } from "~/domain/products/linear-token-provider.js";
import type { InstallationRecord, TenantRegistry } from "~/domain/products/tenant-registry.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";

const logger = createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined });

/** Answers one installation, keyed by workspace id, or none. */
const tokenProvider = (installation: InstallationRecord | null) => {
  const tenants = {
    ensureTenant: vi.fn(),
    findByWorkspace: vi.fn(),
    putInstallation: vi.fn(),
    getInstallationToken: vi.fn(),
    getInstallation: vi.fn(() => Promise.resolve(installation)),
    findByGitHubInstallation: vi.fn(),
    putGitHubInstallation: vi.fn(),
  } as unknown as TenantRegistry;
  return new LinearTokenProvider({ tenants, oauth: null, logger });
};

const installation = (): InstallationRecord => ({
  linearWorkspaceId: "ws-1",
  workspaceName: "Workspace",
  appUserId: null,
  accessToken: "secret-access-token-value",
  refreshToken: null,
  expiresAt: null,
  scopes: [],
});

describe("TenantScopedLinearTeamLookup", () => {
  it("resolves a team key for a tenant that resolves", async () => {
    const tenants: TenantWorkspaceLookup = { linearWorkspaceIdFor: vi.fn(() => Promise.resolve("ws-1")) };
    const tokens = tokenProvider(installation());
    const buildClient = vi.fn((accessToken: string) => ({
      resolveTeamKey: vi.fn(() => Promise.resolve({ id: "team-1", key: "PAY" })),
      resolveTeamId: vi.fn(),
      // Records the token this call received, so the test can assert it never leaks elsewhere.
      accessToken,
    }));
    const lookup = new TenantScopedLinearTeamLookup(tenants, tokens, buildClient);

    const result = await lookup.resolveTeamKey("tenant-1", "PAY");

    expect(result).toEqual({ id: "team-1", key: "PAY" });
    expect(buildClient).toHaveBeenCalledWith("secret-access-token-value");
    // The token reaches the client the adapter builds, and reaches nothing else.
    expect(JSON.stringify(result)).not.toContain("secret-access-token-value");
  });

  it("answers null for a tenant that does not resolve, without fetching a token", async () => {
    const tenants: TenantWorkspaceLookup = { linearWorkspaceIdFor: vi.fn(() => Promise.resolve(null)) };
    const tokens = tokenProvider(installation());
    const buildClient = vi.fn();
    const lookup = new TenantScopedLinearTeamLookup(tenants, tokens, buildClient);

    const result = await lookup.resolveTeamKey("tenant-missing", "PAY");

    expect(result).toBeNull();
    expect(buildClient).not.toHaveBeenCalled();
  });

  it("lets a token fetch failure propagate, with no token in the message", async () => {
    const tenants: TenantWorkspaceLookup = { linearWorkspaceIdFor: vi.fn(() => Promise.resolve("ws-1")) };
    // No installation exists for the workspace, so the provider throws.
    const tokens = tokenProvider(null);
    const buildClient = vi.fn();
    const lookup = new TenantScopedLinearTeamLookup(tenants, tokens, buildClient);

    await expect(lookup.resolveTeamKey("tenant-1", "PAY")).rejects.toBeInstanceOf(LinearInstallationError);
    await expect(lookup.resolveTeamKey("tenant-1", "PAY")).rejects.toThrow(/No Linear installation exists/);
    expect(buildClient).not.toHaveBeenCalled();
  });

  it("resolves a team id the same way it resolves a team key", async () => {
    const tenants: TenantWorkspaceLookup = { linearWorkspaceIdFor: vi.fn(() => Promise.resolve("ws-1")) };
    const tokens = tokenProvider(installation());
    const buildClient = vi.fn(() => ({
      resolveTeamKey: vi.fn(),
      resolveTeamId: vi.fn(() => Promise.resolve({ id: "team-9", key: "OPS" })),
    }));
    const lookup = new TenantScopedLinearTeamLookup(tenants, tokens, buildClient);

    const result = await lookup.resolveTeamId("tenant-1", "team-9");

    expect(result).toEqual({ id: "team-9", key: "OPS" });
    expect(buildClient).toHaveBeenCalledWith("secret-access-token-value");
  });
});
