import type { Logger } from "~/telemetry/logger.js";
import type { InstallationRecord, TenantRegistry } from "~/domain/products/tenant-registry.js";

/**
 * The result of one refresh against the Linear token endpoint.
 *
 * Linear returns a new refresh token on some responses and omits it on others. An omitted value
 * means the old refresh token stays valid, so the provider keeps what it holds.
 */
export interface RefreshedLinearToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

/** The seam over the Linear token endpoint. Only an adapter knows the transport. */
export interface LinearOAuthPort {
  refresh(refreshToken: string): Promise<RefreshedLinearToken>;
}

export class LinearInstallationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearInstallationError";
  }
}

/**
 * A Linear access token lives for twenty-four hours. A worker runs for weeks, so every Run after
 * the first day failed at the first Linear call with "Authentication required", and an operator
 * had to store a new token by hand each day.
 *
 * This provider reads the installation, refreshes the access token before it expires, and writes
 * the new pair back. A caller that receives an authentication error from Linear asks again with
 * `force`, because a token can be revoked long before its expiry.
 *
 * The provider never throws when a refresh fails and the stored token still has time left: the
 * stored token is the better answer, and the next call tries the refresh again. It throws only
 * when it holds nothing usable, because a Run that starts without a token fails at its first
 * Linear call anyway, with a worse message.
 */
export class LinearTokenProvider {
  private readonly skewMs: number;

  constructor(
    private readonly options: {
      tenants: TenantRegistry;
      oauth: LinearOAuthPort | null;
      logger: Logger;
      clock?: () => number;
      /** How long before the expiry a refresh happens. Default five minutes. */
      skewMs?: number;
    },
  ) {
    this.skewMs = options.skewMs ?? 5 * 60_000;
  }

  private now(): number {
    return this.options.clock?.() ?? Date.now();
  }

  private expired(installation: InstallationRecord): boolean {
    if (installation.expiresAt === null) return false;
    return installation.expiresAt.getTime() - this.skewMs <= this.now();
  }

  async tokenFor(linearWorkspaceId: string, options: { force?: boolean } = {}): Promise<string> {
    const installation = await this.options.tenants.getInstallation(linearWorkspaceId);
    if (installation === null) {
      throw new LinearInstallationError(
        `No Linear installation exists for workspace ${linearWorkspaceId}. Store one with ` +
          "PUT /admin/linear-installations.",
      );
    }

    const mustRefresh = options.force === true || this.expired(installation);
    if (!mustRefresh) return installation.accessToken;

    const refreshed = await this.refresh(installation, linearWorkspaceId);
    if (refreshed !== null) return refreshed;

    if (options.force === true || installation.expiresAt !== null) {
      throw new LinearInstallationError(
        `The Linear access token of workspace ${linearWorkspaceId} expired, and Factoree could ` +
          "not refresh it. Install the Linear app again from the Workspaces screen, and store the " +
          "Linear client id and secret in Settings > Install, so a later token refreshes on its own.",
      );
    }
    return installation.accessToken;
  }

  /** Returns the new access token, or null when no refresh was possible. */
  private async refresh(installation: InstallationRecord, workspaceId: string): Promise<string | null> {
    const oauth = this.options.oauth;
    if (oauth === null || installation.refreshToken === null) {
      this.options.logger.warn("the Linear token cannot refresh", {
        step: "linear_token",
        linear_workspace_id: workspaceId,
        // The reason names configuration, never a token value. SDD section 60.
        reason: oauth === null ? "no_oauth_client" : "no_refresh_token",
      });
      return null;
    }

    let result: RefreshedLinearToken;
    try {
      result = await oauth.refresh(installation.refreshToken);
    } catch (error) {
      this.options.logger.warn("the Linear token refresh failed", {
        step: "linear_token",
        linear_workspace_id: workspaceId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    await this.options.tenants.putInstallation({
      linearWorkspaceId: installation.linearWorkspaceId,
      workspaceName: installation.workspaceName,
      ...(installation.appUserId === null ? {} : { appUserId: installation.appUserId }),
      accessToken: result.accessToken,
      // Linear omits the refresh token when the old one stays valid.
      refreshToken: result.refreshToken ?? installation.refreshToken,
      ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
      scopes: installation.scopes,
    });

    this.options.logger.info("the Linear token refreshed", {
      step: "linear_token",
      linear_workspace_id: workspaceId,
      expires_at: result.expiresAt?.toISOString() ?? null,
    });
    return result.accessToken;
  }
}
