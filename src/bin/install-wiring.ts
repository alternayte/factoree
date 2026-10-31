import { createRequire } from "node:module";
import type { GitHubAppCredentials } from "~/adapters/github/app-token-provider.js";
import { createLinearOAuthClient } from "~/adapters/linear/linear-oauth.js";
import type { LinearOAuthPort } from "~/domain/products/linear-token-provider.js";
import { requireSetting, type InstallSettingsStore } from "~/domain/settings/install-settings.js";

/**
 * docs/specs/release-0-1-0.md. The composition of the API and the worker reads every install
 * setting at the moment of use, so a change in the UI needs no restart.
 */

/** The GitHub App identity, read for each token mint. */
export const githubAppCredentials =
  (settings: InstallSettingsStore) => async (): Promise<GitHubAppCredentials> => {
    const { github } = await settings.read();
    return {
      appId: requireSetting(github.appId, "GitHub App id"),
      privateKey: requireSetting(github.privateKey, "GitHub App private key"),
      apiBaseUrl: github.apiBaseUrl,
    };
  };

export const githubApiBaseUrl = (settings: InstallSettingsStore) => async (): Promise<string> =>
  (await settings.read()).github.apiBaseUrl;

export const githubBaseUrl = (settings: InstallSettingsStore) => async (): Promise<string> =>
  (await settings.read()).github.baseUrl;

/** Refreshes a Linear access token with the client credentials the install settings hold now. */
export const linearOAuthFromSettings = (settings: InstallSettingsStore): LinearOAuthPort => ({
  refresh: async (refreshToken) => {
    const { linear } = await settings.read();
    return createLinearOAuthClient({
      clientId: requireSetting(linear.clientId, "Linear client id"),
      clientSecret: requireSetting(linear.clientSecret, "Linear client secret"),
    }).refresh(refreshToken);
  },
});

/** The release version from package.json. */
export const releaseVersion = (): string =>
  (createRequire(import.meta.url)("../../package.json") as { version: string }).version;
