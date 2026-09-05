export interface TenantRecord {
  id: string;
  linearWorkspaceId: string;
  name: string;
}

export interface InstallationInput {
  linearWorkspaceId: string;
  workspaceName: string;
  appUserId?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
}

/**
 * One Linear installation, with the material a refresh needs. A Linear access token lives for
 * twenty-four hours, so a long-lived worker must read the refresh token and the expiry, not the
 * access token alone.
 */
export interface InstallationRecord {
  linearWorkspaceId: string;
  workspaceName: string;
  appUserId: string | null;
  accessToken: string;
  refreshToken: string | null;
  /** Null when the operator stored no expiry. The provider then treats the token as unexpiring. */
  expiresAt: Date | null;
  scopes: string[];
}

export interface TenantRegistry {
  ensureTenant(linearWorkspaceId: string, name: string): Promise<TenantRecord>;
  findByWorkspace(linearWorkspaceId: string): Promise<TenantRecord | null>;
  putInstallation(input: InstallationInput): Promise<TenantRecord>;
  getInstallationToken(linearWorkspaceId: string): Promise<string | null>;
  /** The whole installation. `LinearTokenProvider` needs the refresh token and the expiry. */
  getInstallation(linearWorkspaceId: string): Promise<InstallationRecord | null>;
  /**
   * Resolves a tenant from a GitHub App installation id. The id is stable across an account
   * rename, so a lookup never resolves by the account login.
   */
  findByGitHubInstallation(githubInstallationId: string): Promise<TenantRecord | null>;
  /**
   * Binds a GitHub App installation to a tenant. The numeric installation id is the key. The
   * account login is stored for display only. A later call writes a new login over the same
   * installation id, so an account rename never breaks the binding.
   */
  putGitHubInstallation(
    tenantId: string,
    githubInstallationId: string,
    accountLogin: string,
  ): Promise<void>;
}
