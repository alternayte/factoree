/**
 * The one GitHub App permission name Factoree asks for. GitHub defines many more; this union
 * holds only the names a caller in this codebase actually uses, so an unknown name fails at
 * compile time instead of reaching GitHub as a silently-accepted typo.
 */
export type GitHubPermissionName =
  | "contents"
  | "pull_requests"
  | "workflows"
  | "issues"
  // docs/specs/pr-review-merge-and-deploy.md, D4. The PR workflow reads check runs, commit statuses
  // and the repository settings of the L4 gate.
  | "checks"
  | "statuses"
  | "metadata"
  // Slice 5, DI-21.122. The deploy report reads the deployments of an environment.
  | "deployments"
  // docs/specs/pr-feedback-loop.md. A PR follow-up run reads the job log tail of a failed Actions check.
  | "actions";

/** The access level of one permission. GitHub also defines `admin`; Factoree asks for neither. */
export type GitHubPermissionLevel = "read" | "write";

/**
 * The GitHub permission set a minted token must carry. GitHub's installation token endpoint
 * accepts this shape under `permissions`, and returns a token limited to it. An absent scope
 * means the provider mints against its own default, which an implementation must document.
 *
 * A minted token must carry the narrowest scope its one operation needs. Ruling 2 forbids a
 * blanket token: a write credential must never reach a git clone that a sandbox later uses.
 */
export type GitHubTokenScope = Partial<Record<GitHubPermissionName, GitHubPermissionLevel>>;

/**
 * The GitHub credential of one installation. An implementation mints a short-lived token.
 * The caller passes the installation id on every call. No implementation holds a token at
 * construction, because a held token belongs to one installation and reads another.
 *
 * The caller also passes the scope the token must carry. A provider must cache and de-duplicate
 * a mint per installation AND per scope, never per installation alone. A cached write token
 * answered to a read request would carry write access into a place ruling 2 forbids it.
 */
/**
 * docs/specs/host-credentials.md. `minRemainingMs` asks for a token that lives at least this long,
 * because a sandbox binding keeps it until the next rebind. A cached token with less left is minted again.
 */
export interface GitHubTokenOptions {
  minRemainingMs?: number;
}

export interface GitHubTokenProvider {
  /**
   * `repositories` names the `owner/repo` repositories the token may reach. An absent list
   * reaches every repository of the installation, which only installation-wide work needs.
   */
  tokenForInstallation(
    githubInstallationId: string,
    scope?: GitHubTokenScope,
    repositories?: readonly string[],
    options?: GitHubTokenOptions,
  ): Promise<string>;
}
