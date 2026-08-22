/**
 * One Project secret, without its value.
 *
 * SDD section 30 permits a non-production test secret in the Implementer environment, and only
 * when the operator injects it explicitly. `injectIntoImplementer` is that explicit mark. A
 * secret without the mark still reaches the redactor, because SDD section 60 requires redaction
 * of every Project secret, injected or not.
 */
export interface ProjectSecretDescriptor {
  name: string;
  injectIntoImplementer: boolean;
}

export interface PutSecretOptions {
  /** Default false. Only a marked secret reaches the Implementer environment. */
  injectIntoImplementer?: boolean;
}

export interface SecretStore {
  put(
    tenantId: string,
    projectId: string,
    name: string,
    value: string,
    options?: PutSecretOptions,
  ): Promise<void>;
  get(tenantId: string, projectId: string, name: string): Promise<string | null>;
  listNames(tenantId: string, projectId: string): Promise<string[]>;
  /** Every secret of the Project, with its injection mark. The value never appears here. */
  list(tenantId: string, projectId: string): Promise<ProjectSecretDescriptor[]>;
  remove(tenantId: string, projectId: string, name: string): Promise<boolean>;
}
