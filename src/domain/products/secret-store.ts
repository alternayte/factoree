/**
 * SDD section 30 permits three kinds of Project secret inside a Run, and forbids Linear tokens,
 * GitHub write credentials, production secrets, and Factoree admin credentials in an agent
 * session. The kind states what a secret is for, so each carrier applies its own rule:
 *
 * - `test`: a non-production test secret. It reaches an agent session only with the explicit
 *   `injectIntoImplementer` mark, and `guardAgainstForbiddenMaterial` inspects it there.
 * - `runner_credential`: a model provider credential of the coding agent. It reaches the sandbox
 *   environment, never a prompt, and never the Implementer input.
 * - `repository_read`: retired. The GitHub App installation replaced it as the one credential
 *   path to GitHub, and no code reads a secret of this kind any more. The kind stays defined so
 *   an existing stored row keeps its kind rather than silently becoming `test`, which is the one
 *   kind the injection mark permits.
 * - `publish`: retired, for the same reason and the same guard as `repository_read`.
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
    productId: string,
    name: string,
    value: string,
    options?: PutSecretOptions,
  ): Promise<void>;
  get(tenantId: string, productId: string, name: string): Promise<string | null>;
  listNames(tenantId: string, productId: string): Promise<string[]>;
  /** Every secret of the Product, with its injection mark and its kind. The value never appears here. */
  list(tenantId: string, productId: string): Promise<ProjectSecretDescriptor[]>;
  remove(tenantId: string, productId: string, name: string): Promise<boolean>;
}

/**
 * Thrown when a repository requests a secret the Product secret store does not hold. The message
 * names every absent secret, not only the first, because an operator can then repair every gap
 * before the next Run. A repository can only name a secret in `.factoree/config.yaml`. It can
 * never supply a value. An unmatched name must fail the Run, rather than run silently.
 */
export class MissingSecretError extends Error {
  constructor(readonly missingNames: string[]) {
    super(`The Product secret store is missing the following requested secret name(s): ${missingNames.join(", ")}.`);
    this.name = "MissingSecretError";
  }
}

/**
 * Checks that every name a repository requests exists in the Product secret store. `requested`
 * holds names parsed from `.factoree/config.yaml`. `available` holds the names the Product
 * secret store actually holds. A name absent from `available` fails the whole check.
 */
export const assertRequestedSecretsExist = (requested: string[], available: string[]): void => {
  const availableNames = new Set(available);
  const missingNames = requested.filter((name) => !availableNames.has(name));
  if (missingNames.length > 0) throw new MissingSecretError(missingNames);
};
