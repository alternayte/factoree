import type { LinearOAuthPort, RefreshedLinearToken } from "~/domain/products/linear-token-provider.js";

/** SDD section 59. The Linear token endpoint. */
const TOKEN_URL = "https://api.linear.app/oauth/token";

/** One refresh must not hang a Run. */
const REFRESH_TIMEOUT_MS = 15_000;

export interface LinearOAuthOptions {
  clientId: string;
  clientSecret: string;
  /** A test points this at a fixture server. */
  tokenUrl?: string;
  fetch?: typeof fetch;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

/**
 * Exchanges a Linear refresh token for a new access token.
 *
 * The credentials travel in the body, the way Linear documents the flow. No value of the
 * response reaches an error message, because a token endpoint answers with tokens and SDD
 * section 60 forbids one in a log line.
 */
export const createLinearOAuthClient = (options: LinearOAuthOptions): LinearOAuthPort => {
  const call = options.fetch ?? fetch;
  const url = options.tokenUrl ?? TOKEN_URL;

  return {
    async refresh(refreshToken: string): Promise<RefreshedLinearToken> {
      const body = new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });

      const response = await call(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });

      if (!response.ok) {
        // The status alone. A body from a token endpoint can carry a credential.
        throw new Error(`the Linear token endpoint answered ${response.status}`);
      }

      const parsed = (await response.json()) as TokenResponse;
      if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
        throw new Error("the Linear token endpoint answered without an access token");
      }

      return {
        accessToken: parsed.access_token,
        ...(typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
          ? { refreshToken: parsed.refresh_token }
          : {}),
        ...(typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)
          ? { expiresAt: new Date(Date.now() + parsed.expires_in * 1_000) }
          : {}),
      };
    },
  };
};
