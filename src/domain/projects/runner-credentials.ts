import { isGithubOrLinearCredentialValue } from "~/domain/security/credential-formats.js";
import { isForbiddenName } from "~/domain/runs/implementer-input.js";
import type { ProjectSecretKind, SecretStore } from "~/domain/products/secret-store.js";
import type { Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";

/**
 * SDD section 30 forbids a Linear token, a GitHub write credential, a production secret, and a
 * Factoree admin credential in an agent session. A model provider credential is none of those, so
 * a coding agent can hold one. This module carries that credential from the Project secret store
 * to the sandbox environment, and it refuses anything the section forbids.
 *
 * The credential never enters a prompt, never enters `ImplementerInput`, and never crosses a
 * Temporal boundary. Each activity reads it again from the store, so no workflow argument and no
 * workflow history holds the value.
 */
/**
 * A credential an operator must repair. It extends `RunConfigurationError`, and it keeps that
 * name, so the workflow retry policy already treats it as non-retryable and the Run ends
 * `CONFIGURATION_INVALID`. A retry would read the same secret and fail the same way. SDD section
 * 49. The class stays distinct so the admin route can answer 400 rather than 500.
 */
export class RunnerCredentialError extends RunConfigurationError {}

/**
 * Refuses a runner credential that SDD section 30 forbids. The value test is the primary control,
 * because a value reveals a provider far more reliably than a name does. The name test is the
 * secondary one, and it catches `PRODUCTION_...` or `FACTOREE_ADMIN_...` over a value in no known
 * format.
 */
export const assertRunnerCredential = (name: string, value: string): void => {
  if (isGithubOrLinearCredentialValue(value)) {
    throw new RunnerCredentialError(
      `The secret "${name}" holds a GitHub or a Linear credential. SDD section 30 forbids either ` +
        "in an agent session. A runner credential must belong to a model provider.",
    );
  }
  if (isForbiddenName(name)) {
    throw new RunnerCredentialError(
      `The name "${name}" names material SDD section 30 forbids in an agent session. Rename the ` +
        "secret after its model provider.",
    );
  }
};

/**
 * Every runner credential of one Project, as an environment. The caller merges it into the agent
 * process environment. An empty result is normal: a Project that uses a model needing no
 * credential holds no runner credential.
 */
export const loadRunnerEnvironment = async (
  secrets: SecretStore,
  tenantId: string,
  projectId: string,
): Promise<Record<string, string>> => {
  const descriptors = await secrets.list(tenantId, projectId);
  const environment: Record<string, string> = {};
  for (const descriptor of descriptors) {
    if (descriptor.kind !== ("runner_credential" satisfies ProjectSecretKind)) continue;
    const value = await secrets.get(tenantId, projectId, descriptor.name);
    if (value === null || value === "") continue;
    assertRunnerCredential(descriptor.name, value);
    environment[descriptor.name] = value;
  }
  return environment;
};

/**
 * Attaches the runner credentials of one Project to one sandbox, so every later command of that
 * sandbox receives them.
 *
 * Every activity that execs into a sandbox calls this, because the attachment lives in the worker
 * process that made it, and another worker can run the next activity.
 */
export const attachRunnerEnvironment = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  secrets: SecretStore,
  tenantId: string,
  projectId: string,
): Promise<void> => {
  sandbox.attachEnvironment(ref, await loadRunnerEnvironment(secrets, tenantId, projectId));
};

/**
 * The read-only repository credential of one Project, or null when the Project holds none. SDD
 * section 30 forbids a GitHub write credential in an agent session, so this value must never be a
 * token that can push.
 */
export const loadRepositoryReadToken = async (
  secrets: SecretStore,
  tenantId: string,
  projectId: string,
): Promise<string | null> => {
  const descriptors = await secrets.list(tenantId, projectId);
  const descriptor = descriptors.find((entry) => entry.kind === "repository_read");
  if (descriptor === undefined) return null;
  const value = await secrets.get(tenantId, projectId, descriptor.name);
  return value === null || value === "" ? null : value;
};
