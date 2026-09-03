export interface ProjectRecord {
  id: string;
  tenantId: string;
  key: string;
  name: string;
  primaryRepository: string;
  referenceRepositories: string[];
  /** SDD section 16. An owner and repository slug, or null. */
  organizationSkillsRepository: string | null;
  linearTeamId: string | null;
  defaultAutonomy: string;
  maxRunMinutes: number;
  defaultBranch: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProjectInput {
  tenantId: string;
  key: string;
  name: string;
  primaryRepository: string;
  referenceRepositories?: string[];
  organizationSkillsRepository?: string | null;
  linearTeamId?: string;
  defaultAutonomy?: string;
  maxRunMinutes?: number;
  defaultBranch?: string;
}

export type UpdateProjectInput = Partial<Omit<CreateProjectInput, "tenantId" | "key">>;

export interface ProjectRegistry {
  create(input: CreateProjectInput): Promise<ProjectRecord>;
  list(tenantId: string): Promise<ProjectRecord[]>;
  findById(tenantId: string, id: string): Promise<ProjectRecord | null>;
  findByLinearTeam(tenantId: string, linearTeamId: string): Promise<ProjectRecord | null>;
  findDefaultForTenant(tenantId: string): Promise<ProjectRecord | null>;
  update(tenantId: string, id: string, input: UpdateProjectInput): Promise<ProjectRecord | null>;
  remove(tenantId: string, id: string): Promise<boolean>;
}

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
}
