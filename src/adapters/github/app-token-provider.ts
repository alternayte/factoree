import { createPrivateKey, createSign } from "node:crypto";
import type { GitHubTokenProvider } from "~/domain/products/github-token-provider.js";

const DEFAULT_API_BASE_URL = "https://api.github.com";
/** Refresh under this margin. A long operation must not race the expiry boundary. */
const REFRESH_MARGIN_MS = 300_000;

export class GitHubAppAuthError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly githubInstallationId: string,
  ) {
    super(message);
    this.name = "GitHubAppAuthError";
  }
}

const base64Url = (input: Buffer): string =>
  input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

type CacheEntry = { token: string; expiresAtMs: number };

/** The fields a `GitHubAppTokenProvider` needs to mint a token for one installation. */
export interface GitHubAppTokenProviderOptions {
  appId: string;
  privateKeyBase64: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Mints a GitHub App installation access token. The provider signs a short-lived App JWT with
 * `node:crypto`, then exchanges it for a token scoped to one installation. It caches the minted
 * token per installation and refreshes it before the five-minute margin runs out, because a long
 * operation must not race the expiry boundary.
 *
 * The provider never holds a token at construction. The caller passes the installation id on
 * every call, because a held token belongs to one installation and reads another.
 */
export class GitHubAppTokenProvider implements GitHubTokenProvider {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: GitHubAppTokenProviderOptions) {}

  async tokenForInstallation(githubInstallationId: string): Promise<string> {
    const now = this.options.now?.() ?? Date.now();
    const cached = this.cache.get(githubInstallationId);
    if (cached !== undefined && cached.expiresAtMs - now > REFRESH_MARGIN_MS) return cached.token;

    const minted = await this.mint(githubInstallationId, now);
    this.cache.set(githubInstallationId, minted);
    return minted.token;
  }

  /** Signs the App JWT. `iat` is backdated against clock skew. `exp` sits inside the ten-minute ceiling. */
  private signJwt(nowMs: number): string {
    const header = base64Url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const seconds = Math.floor(nowMs / 1000);
    const payload = base64Url(
      Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: this.options.appId })),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    signer.end();
    const key = createPrivateKey(Buffer.from(this.options.privateKeyBase64, "base64").toString("utf8"));
    return `${header}.${payload}.${base64Url(signer.sign(key))}`;
  }

  private async mint(githubInstallationId: string, nowMs: number): Promise<CacheEntry> {
    const base = (this.options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    const url = `${base}/app/installations/${githubInstallationId}/access_tokens`;
    const fetchImpl = this.options.fetch ?? fetch;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.signJwt(nowMs)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (response.status !== 201) {
      throw new GitHubAppAuthError(
        `the GitHub API answered ${String(response.status)} while it minted a token for installation ${githubInstallationId}`,
        response.status,
        githubInstallationId,
      );
    }
    const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
      throw new GitHubAppAuthError(
        `the GitHub API returned no token for installation ${githubInstallationId}`,
        null,
        githubInstallationId,
      );
    }
    return { token: body.token, expiresAtMs: Date.parse(body.expires_at) };
  }
}
