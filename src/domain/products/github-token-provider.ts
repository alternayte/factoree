/**
 * The one GitHub App permission name Factoree asks for. GitHub defines many more; this union
 * holds only the names a caller in this codebase actually uses, so an unknown name fails at
 * compile time instead of reaching GitHub as a silently-accepted typo.
 */
export type GitHubPermissionName = "contents" | "pull_requests";

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
export interface GitHubTokenProvider {
  /**
   * `repositories` names the `owner/repo` repositories the token may reach. An absent list
   * reaches every repository of the installation, which only installation-wide work needs.
   */
  tokenForInstallation(
    githubInstallationId: string,
    scope?: GitHubTokenScope,
    repositories?: readonly string[],
  ): Promise<string>;
}
