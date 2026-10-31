/**
 * The GitHub REST API URL of an adapter. A test passes a fixed string. The worker and the API
 * pass a function that reads the install settings for each call, so a GitHub Enterprise URL
 * changed in the UI applies with no restart (docs/specs/release-0-1-0.md).
 */
export type GitHubApiBaseUrl = string | (() => Promise<string>);

export const resolveGitHubApiBaseUrl = async (value: GitHubApiBaseUrl): Promise<string> =>
  (typeof value === "string" ? value : await value()).replace(/\/+$/, "");
