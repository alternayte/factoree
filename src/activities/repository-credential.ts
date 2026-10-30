import type { RepositoryCredential } from "~/adapters/github/git-repository-reader.js";
import type { GitHubTokenProvider } from "~/domain/products/github-token-provider.js";
import type { Redactor } from "~/telemetry/redaction.js";

/**
 * Wraps a `GitHubTokenProvider` so every token it mints reaches the redactor before the caller
 * can spend it. `GitRepositoryReader` mints immediately before the git command that uses the
 * token, so this wrapper is the only point between the mint and that command. A token must never
 * reach output by design, and the redactor is the guarantee that survives a later edit by someone
 * who does not know the rule.
 */
export const redactingTokens = (tokens: GitHubTokenProvider, redactor: Redactor): GitHubTokenProvider => ({
  tokenForInstallation: async (githubInstallationId, scope, repositories) => {
    const token = await tokens.tokenForInstallation(githubInstallationId, scope, repositories);
    redactor.addSecret(token);
    return token;
  },
});

/**
 * The read-only credential source of one Run's repository reads, or null when the repository
 * carries no GitHub App installation or has no origin (a local path). The installation id names
 * the source of the credential, and a Product can move a repository between two installations
 * between two Runs, so each activity reads the id fresh.
 */
export const readCredential = (
  repositoryUrl: string,
  githubInstallationId: string,
  dependencies: { tokens: GitHubTokenProvider; redactor: Redactor },
): RepositoryCredential | null => {
  if (githubInstallationId === "") return null;
  let origin: string;
  try {
    origin = new URL(repositoryUrl).origin;
  } catch {
    return null;
  }
  if (origin === "null") return null;
  return {
    origin,
    tokens: redactingTokens(dependencies.tokens, dependencies.redactor),
    githubInstallationId,
  };
};

/**
 * The `owner/repo` names of the GitHub repositories among `urls`. A minted token reaches these
 * repositories only. Undefined when no URL names one, for example a local path in a test.
 */
export const repositoryNamesOf = (urls: readonly string[]): string[] | undefined => {
  const names: string[] = [];
  for (const url of urls) {
    try {
      const parts = new URL(url).pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
      if (parts.length === 2 && parts[0] !== "" && parts[1] !== "") names.push(`${parts[0]}/${parts[1]}`);
    } catch {
      continue;
    }
  }
  return names.length === 0 ? undefined : names;
};
