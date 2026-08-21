export interface SecretStore {
  put(tenantId: string, projectId: string, name: string, value: string): Promise<void>;
  get(tenantId: string, projectId: string, name: string): Promise<string | null>;
  listNames(tenantId: string, projectId: string): Promise<string[]>;
  remove(tenantId: string, projectId: string, name: string): Promise<boolean>;
}
