/**
 * SDD section 30 permits three kinds of Project secret inside a Run, and forbids Linear tokens,
 * GitHub write credentials, production secrets, and Factoree admin credentials in an agent
 * session. The kind states what a secret is for, so each carrier applies its own rule:
 *
 * - `test`: a non-production test secret. It reaches an agent session only with the explicit
 *   `injectIntoImplementer` mark, and `guardAgainstForbiddenMaterial` inspects it there.
 * - `runner_credential`: a model provider credential of the coding agent. It reaches the sandbox
 *   environment, never a prompt, and never the Implementer input.
 * - `repository_read`: a read-only repository credential. It is used for one git command at a
 *   time and never stays inside the sandbox.
 * - `publish`: the GitHub write credential of the publication. It never enters a sandbox.
 *
 * A secret of any kind other than `test` must not carry the injection mark. The store rejects
 * that combination, so a credential cannot reach the Implementer path by a configuration slip.
 */
export const PROJECT_SECRET_KINDS = ["test", "runner_credential", "repository_read", "publish"] as const;

export type ProjectSecretKind = (typeof PROJECT_SECRET_KINDS)[number];

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
  kind: ProjectSecretKind;
}

export interface PutSecretOptions {
  /** Default false. Only a marked secret reaches the Implementer environment. */
  injectIntoImplementer?: boolean;
  /** Default `test`, which keeps the behaviour of every secret written before the kind existed. */
  kind?: ProjectSecretKind;
}

/** A secret kind and an injection mark that SDD section 30 does not allow together. */
export class ProjectSecretKindError extends Error {
  constructor(kind: ProjectSecretKind) {
    super(
      `A secret of kind "${kind}" must not carry the injection mark. SDD section 30 permits the ` +
        'mark on a "test" secret only. Store the credential without the mark.',
    );
    this.name = "ProjectSecretKindError";
  }
}

/** Rejects a kind and a mark that must never appear together. */
export const assertSecretKindAndMark = (kind: ProjectSecretKind, injectIntoImplementer: boolean): void => {
  if (kind !== "test" && injectIntoImplementer) throw new ProjectSecretKindError(kind);
};

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
  /** Every secret of the Project, with its injection mark and its kind. The value never appears here. */
  list(tenantId: string, projectId: string): Promise<ProjectSecretDescriptor[]>;
  remove(tenantId: string, projectId: string, name: string): Promise<boolean>;
}
