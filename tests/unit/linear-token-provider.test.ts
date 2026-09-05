import { describe, expect, it, vi } from "vitest";
import {
  LinearInstallationError,
  LinearTokenProvider,
} from "~/domain/products/linear-token-provider.js";
import type { InstallationInput, InstallationRecord, TenantRegistry } from "~/domain/products/tenant-registry.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";

const logger = createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined });

const installation = (over: Partial<InstallationRecord> = {}): InstallationRecord => ({
  linearWorkspaceId: "ws-1",
  workspaceName: "Workspace",
  appUserId: "app-1",
  accessToken: "old-access",
  refreshToken: "refresh-1",
  expiresAt: new Date("2026-08-28T12:00:00Z"),
  scopes: ["read", "write"],
  ...over,
});

const registry = (record: InstallationRecord | null) => {
  const stored: InstallationInput[] = [];
  const tenants = {
    ensureTenant: vi.fn(),
    findByWorkspace: vi.fn(),
    putInstallation: vi.fn((input: InstallationInput) => {
      stored.push(input);
      return Promise.resolve({ id: "t", linearWorkspaceId: input.linearWorkspaceId, name: input.workspaceName });
    }),
    getInstallationToken: vi.fn(),
    getInstallation: vi.fn(() => Promise.resolve(record)),
  } as unknown as TenantRegistry;
  return { tenants, stored };
};

describe("LinearTokenProvider", () => {
  it("returns the stored token while it has time left", async () => {
    const { tenants } = registry(installation());
    const oauth = { refresh: vi.fn() };
    const provider = new LinearTokenProvider({
      tenants, oauth, logger,
      clock: () => new Date("2026-08-28T11:00:00Z").getTime(),
    });

    await expect(provider.tokenFor("ws-1")).resolves.toBe("old-access");
    expect(oauth.refresh).not.toHaveBeenCalled();
  });

  it("refreshes before the expiry and stores the new pair", async () => {
    const { tenants, stored } = registry(installation());
    const oauth = {
      refresh: vi.fn().mockResolvedValue({
        accessToken: "new-access",
        refreshToken: "refresh-2",
        expiresAt: new Date("2026-08-29T12:00:00Z"),
      }),
    };
    const provider = new LinearTokenProvider({
      tenants, oauth, logger,
      // Inside the five-minute skew, so the token counts as expiring.
      clock: () => new Date("2026-08-28T11:57:00Z").getTime(),
    });

    await expect(provider.tokenFor("ws-1")).resolves.toBe("new-access");
    expect(oauth.refresh).toHaveBeenCalledWith("refresh-1");
    expect(stored[0]).toMatchObject({
      linearWorkspaceId: "ws-1",
      accessToken: "new-access",
      refreshToken: "refresh-2",
      appUserId: "app-1",
      scopes: ["read", "write"],
    });
  });

  it("keeps the old refresh token when Linear returns none", async () => {
    const { tenants, stored } = registry(installation());
    const oauth = { refresh: vi.fn().mockResolvedValue({ accessToken: "new-access" }) };
    const provider = new LinearTokenProvider({
      tenants, oauth, logger,
      clock: () => new Date("2026-08-28T13:00:00Z").getTime(),
    });

    await provider.tokenFor("ws-1");

    expect(stored[0]?.refreshToken).toBe("refresh-1");
  });

  it("refreshes on demand, for a token revoked before its expiry", async () => {
    const { tenants } = registry(installation());
    const oauth = { refresh: vi.fn().mockResolvedValue({ accessToken: "new-access" }) };
    const provider = new LinearTokenProvider({
      tenants, oauth, logger,
      clock: () => new Date("2026-08-28T09:00:00Z").getTime(),
    });

    await expect(provider.tokenFor("ws-1", { force: true })).resolves.toBe("new-access");
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
  });

  it("names the endpoint to configure when the installation is absent", async () => {
    const { tenants } = registry(null);
    const provider = new LinearTokenProvider({ tenants, oauth: null, logger });

    await expect(provider.tokenFor("ws-1")).rejects.toThrow(LinearInstallationError);
    await expect(provider.tokenFor("ws-1")).rejects.toThrow(/PUT \/admin\/linear-installations/);
  });

  it("explains what to configure when an expired token cannot refresh", async () => {
    const { tenants } = registry(installation({ refreshToken: null }));
    const provider = new LinearTokenProvider({
      tenants, oauth: null, logger,
      clock: () => new Date("2026-08-29T00:00:00Z").getTime(),
    });

    await expect(provider.tokenFor("ws-1")).rejects.toThrow(/LINEAR_CLIENT_ID/);
  });

  it("keeps serving a token that still works when the refresh fails", async () => {
    // A network fault must not end a Run while the stored token is still inside its window.
    const { tenants } = registry(installation({ expiresAt: null }));
    const oauth = { refresh: vi.fn().mockRejectedValue(new Error("network down")) };
    const provider = new LinearTokenProvider({ tenants, oauth, logger });

    await expect(provider.tokenFor("ws-1", { force: false })).resolves.toBe("old-access");
  });
});
