import { GitHubAppAuthError } from "~/adapters/github/app-token-provider.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import type { Redactor } from "~/telemetry/redaction.js";

/**
 * Reports whether a `GitHubAppAuthError` names a fault of the request itself, not a temporary
 * infrastructure fault. A 401 and a 403 mean the installation, or its grant, is wrong. A 404
 * means the installation id names nothing GitHub knows. A 422 means the requested permissions
 * are not a subset of what the installation grants. All four repeat on every retry. A 5xx and a
 * network failure carry no such status. Both stay retryable.
 *
 * Every mint site of a GitHub App credential must apply this same check, because a mint can fail
 * at the sandbox clone, at context resolution, and at publication. This function is the single
 * definition, so the three sites never drift apart.
 */
export const isDeterministicGitHubAppAuthError = (error: GitHubAppAuthError): boolean =>
  error.status === 401 || error.status === 403 || error.status === 404 || error.status === 422;

/**
 * Builds the operator-facing message of a deterministic `GitHubAppAuthError`. GitHub answers 422
 * both for a permission the installation lacks and for a repository it cannot read, so the
 * message quotes GitHub and names every repository the mint asked for.
 */
export const githubAppAuthFaultMessage = (error: GitHubAppAuthError): string => {
  if (error.status === 422) {
    const said = error.githubMessage === undefined ? "" : ` GitHub said: "${error.githubMessage}"`;
    const asked =
      error.repositories === undefined || error.repositories.length === 0
        ? ""
        : ` Factoree asked for these repositories: ${error.repositories.join(", ")}.`;
    return (
      `Factoree could not mint a GitHub credential for installation ${error.githubInstallationId}: ` +
      `the GitHub API answered 422.${said}${asked} Check that the installation's repository access ` +
      "includes each of them, and that the installation accepted every permission the App asks for, " +
      "then retry the Run."
    );
  }
  return (
    `Factoree could not mint a GitHub credential for installation ${error.githubInstallationId}: ` +
    `the GitHub API answered ${String(error.status)}. Install the Factoree GitHub App on the ` +
    "target repository, or repair the existing installation, then retry the Run."
  );
};

/**
 * Finds the `GitHubAppAuthError` a caught error names, directly or as its `cause`. `git-
 * repository-reader.ts` wraps every mint that runs inside a git command into a
 * `RepositoryReadError`, with the original error as the `cause`, so a mint rejected during
 * context resolution never reaches a caller as a bare `GitHubAppAuthError`. The sandbox and the
 * publish activities mint directly, so their rejection needs no unwrap. One level of `cause` is
 * enough for every mint site this branch adds.
 */
const findGitHubAppAuthError = (error: unknown): GitHubAppAuthError | null => {
  if (error instanceof GitHubAppAuthError) return error;
  if (error instanceof Error && error.cause instanceof GitHubAppAuthError) return error.cause;
  return null;
};

/**
 * Converts a deterministic `GitHubAppAuthError` into a `RunConfigurationError`, so every mint
 * site of a GitHub App credential reports the identical configuration fault the workflow
 * recognises. Every other error passes through unchanged. The message reaches the redactor
 * first, so no credential can echo through it.
 *
 * SDD section 49. A semantic mint failure must not consume the Temporal retry policy: an
 * operator must repair the GitHub App installation, not wait for a retry.
 */
export const asRunConfigurationErrorIfDeterministic = (redactor: Redactor, error: unknown): unknown => {
  const authError = findGitHubAppAuthError(error);
  if (authError !== null && isDeterministicGitHubAppAuthError(authError)) {
    return new RunConfigurationError(redactor.redactText(githubAppAuthFaultMessage(authError)));
  }
  return error;
};
