export interface ProjectRecord {
  id: string;
  tenantId: string;
  key: string;
  name: string;
  primaryRepository: string;
  referenceRepositories: string[];
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

export interface TenantRegistry {
  ensureTenant(linearWorkspaceId: string, name: string): Promise<TenantRecord>;
  findByWorkspace(linearWorkspaceId: string): Promise<TenantRecord | null>;
  putInstallation(input: InstallationInput): Promise<TenantRecord>;
  getInstallationToken(linearWorkspaceId: string): Promise<string | null>;
}
