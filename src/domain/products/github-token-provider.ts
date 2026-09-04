/**
 * The GitHub credential of one installation. An implementation mints a short-lived token.
 * The caller passes the installation id on every call. No implementation holds a token at
 * construction, because a held token belongs to one installation and reads another.
 */
export interface GitHubTokenProvider {
  tokenForInstallation(githubInstallationId: string): Promise<string>;
}
