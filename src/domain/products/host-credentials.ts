import type { CredentialBinding } from "~/domain/runs/sandbox.js";
import type { ProjectSecretKind, SecretStore } from "./secret-store.js";

/**
 * docs/specs/host-credentials.md. A product credential for one private host that the sandbox
 * provider adds to requests outside the guest. `registry` is a container registry login, `header`
 * is one header for a package feed, and `github` is a read-only installation token for git fetches
 * from listed repositories of the product's GitHub App installation.
 */
export const HOST_CREDENTIAL_KINDS = ["registry", "header", "github"] as const;
export type HostCredentialKind = (typeof HOST_CREDENTIAL_KINDS)[number];

/** Kiln allows 16 bindings per sandbox and E2B 10 rule domains. A registry takes two bindings. */
export const MAX_HOST_CREDENTIALS = 8;
export const MAX_REDIRECT_HOSTS = 4;
export const MAX_GITHUB_REPOSITORIES = 50;
/** The host of every `github` credential: git over HTTPS to github.com. */
export const GITHUB_GIT_HOST = "github.com";
/**
 * The worker binds a new `github` token at least this often. An installation token lives 1 hour,
 * so a token minted with `GITHUB_TOKEN_MIN_REMAINING_MS` left outlives the next refresh.
 */
export const GITHUB_REBIND_INTERVAL_MS = 10 * 60_000;
export const GITHUB_REBIND_AFTER_MS = 30 * 60_000;
export const GITHUB_TOKEN_MIN_REMAINING_MS = 40 * 60_000;

/** The secret kind of a `registry` or `header` secret. */
export const HOST_CREDENTIAL_SECRET_KIND = "host_credential" satisfies ProjectSecretKind;
/** The prefix of every host credential secret name. */
export const HOST_CREDENTIAL_SECRET_PREFIX = "host:";
/** The product secret name of the credential for one host. */
export const hostCredentialSecretName = (host: string): string => `${HOST_CREDENTIAL_SECRET_PREFIX}${host}`;

export interface HostCredential {
  kind: HostCredentialKind;
  host: string;
  /** `registry` only. */
  username: string | null;
  /** `header` only. */
  headerName: string | null;
  /** `header` only. A path prefix such as `/acme/`. */
  pathPrefix: string | null;
  /** `registry` only: the token service from `WWW-Authenticate`, found on save. */
  realmHost: string | null;
  realmPath: string | null;
  redirectHosts: string[];
  /** `github` only: `owner/name`. */
  repositories: string[];
  /** `github` only: the installation that sees every listed repository. */
  githubInstallationId: string | null;
}

/** One credential as the operator enters it. `secret` is absent to keep the stored secret. */
export interface HostCredentialInput {
  kind: HostCredentialKind;
  host: string;
  username?: string | null;
  headerName?: string | null;
  pathPrefix?: string | null;
  redirectHosts?: string[];
  repositories?: string[];
  secret?: string | null;
}

export interface HostCredentialStore {
  list(tenantId: string, productId: string): Promise<HostCredential[]>;
  /** Replaces the whole list of the product. The caller writes and drops the secrets. */
  replace(tenantId: string, productId: string, credentials: readonly HostCredential[]): Promise<void>;
}

/** An exact host name with at least two labels and no wildcard. */
const EXACT_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// A control character can split a header, and Kiln refuses it.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The checks of one save, in the order the operator reads them. An empty result means the list
 * is valid. `stored` holds the hosts that already have a stored secret.
 */
export const validateHostCredentials = (inputs: readonly HostCredentialInput[], stored: ReadonlySet<string>): string[] => {
  const errors: string[] = [];
  if (inputs.length > MAX_HOST_CREDENTIALS) errors.push(`A product holds at most ${MAX_HOST_CREDENTIALS} host credentials.`);
  const hosts = new Set<string>();
  for (const [index, input] of inputs.entries()) {
    const label = `Host credential ${index + 1}`;
    const host = input.kind === "github" ? GITHUB_GIT_HOST : input.host.trim().toLowerCase();
    if (!EXACT_HOST.test(host)) errors.push(`${label}: "${input.host}" is not one exact host name. A wildcard is not allowed.`);
    if (hosts.has(host)) errors.push(`${label}: ${host} is listed twice.`);
    hosts.add(host);
    const redirects = input.redirectHosts ?? [];
    if (redirects.length > MAX_REDIRECT_HOSTS) errors.push(`${label}: at most ${MAX_REDIRECT_HOSTS} redirect hosts.`);
    for (const redirect of redirects) {
      if (!EXACT_HOST.test(redirect.trim().toLowerCase())) errors.push(`${label}: redirect host "${redirect}" is not one exact host name.`);
    }
    const secret = input.secret ?? null;
    if (secret !== null && CONTROL.test(secret)) errors.push(`${label}: the secret holds a control character.`);
    const needsSecret = input.kind !== "github" && (secret === null || secret === "") && !stored.has(host);
    if (input.kind === "registry") {
      if ((input.username ?? "").trim() === "") errors.push(`${label}: a registry login needs a username.`);
      if (needsSecret) errors.push(`${label}: a registry login needs a secret.`);
    } else if (input.kind === "header") {
      if (!HEADER_NAME.test((input.headerName ?? "").trim())) errors.push(`${label}: a header credential needs a header name.`);
      const path = input.pathPrefix ?? null;
      if (path !== null && path !== "" && !path.startsWith("/")) errors.push(`${label}: the path prefix must start with "/".`);
      if (needsSecret) errors.push(`${label}: a header credential needs a secret.`);
    } else {
      const repositories = input.repositories ?? [];
      if (repositories.length > MAX_GITHUB_REPOSITORIES) errors.push(`${label}: at most ${MAX_GITHUB_REPOSITORIES} repositories.`);
      for (const repository of repositories) {
        if (!REPOSITORY.test(repository.trim())) errors.push(`${label}: "${repository}" is not an owner/name repository.`);
      }
    }
  }
  return errors;
};

/** The normalised record of one valid input. The realm and the installation come from the save checks. */
export const hostCredentialOf = (input: HostCredentialInput): HostCredential => ({
  kind: input.kind,
  host: input.kind === "github" ? GITHUB_GIT_HOST : input.host.trim().toLowerCase(),
  username: input.kind === "registry" ? (input.username ?? "").trim() : null,
  headerName: input.kind === "header" ? (input.headerName ?? "").trim() : null,
  pathPrefix: input.kind === "header" && (input.pathPrefix ?? "") !== "" ? (input.pathPrefix ?? null) : null,
  realmHost: null,
  realmPath: null,
  redirectHosts: [...new Set((input.redirectHosts ?? []).map((host) => host.trim().toLowerCase()))].sort(),
  repositories: input.kind === "github" ? [...new Set((input.repositories ?? []).map((name) => name.trim()))].sort() : [],
  githubInstallationId: null,
});

/**
 * The hosts a sandbox of the product reaches because of its credentials: each credential host, a
 * registry's token service and every redirect host. Each joins the egress of every phase.
 */
export const credentialHostsOf = (credentials: readonly HostCredential[]): string[] => {
  const hosts = new Set<string>();
  for (const credential of credentials) {
    hosts.add(credential.host);
    if (credential.realmHost !== null) hosts.add(credential.realmHost);
    for (const redirect of credential.redirectHosts) hosts.add(redirect);
  }
  return [...hosts].sort();
};

/**
 * The part of the bootstrap key that the credentials decide: each host with its redirect hosts
 * and, for `github`, its repositories. A secret or a token rotation changes nothing here.
 */
export const credentialKeyOf = (credentials: readonly HostCredential[]): string[] =>
  credentials
    .map((credential) =>
      [credential.host, ...credential.redirectHosts, ...(credential.kind === "github" ? credential.repositories : [])].join(" "),
    )
    .sort();

/**
 * The redirect hosts the form suggests for a GitHub Packages host. They come from GitHub's runner
 * docs, community answers and observed redirects, not from a documented list, so the operator
 * confirms each one. GitHub issue 83: in November 2026 a NuGet download redirected to
 * nugetregistryv2prod.blob.core.windows.net. The older host stays, because GitHub moves them.
 * The `<ecosystem>registryv2prod` hosts of npm, Maven and RubyGems follow the same pattern.
 */
export const SUGGESTED_REDIRECT_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "ghcr.io": ["pkg-containers.githubusercontent.com"],
  "npm.pkg.github.com": ["pkg-npm.githubusercontent.com", "npmregistryv2prod.blob.core.windows.net"],
  "nuget.pkg.github.com": ["nugetregistryv2prod.blob.core.windows.net", "github-registry-files.githubusercontent.com"],
  "maven.pkg.github.com": ["mavenregistryv2prod.blob.core.windows.net", "github-registry-files.githubusercontent.com"],
  "rubygems.pkg.github.com": ["rubygemsregistryv2prod.blob.core.windows.net"],
};

const READ_METHODS: CredentialBinding["methods"] = ["GET", "HEAD"];

/** The value a registry sends: Basic of `username:secret`. The redactor holds it too. */
export const basicOf = (username: string, secret: string): string =>
  `Basic ${Buffer.from(`${username}:${secret}`, "utf8").toString("base64")}`;

/**
 * The bindings of one credential. A registry binds its token service, or `/v2/` when it has none.
 * A `github` token binds GET, HEAD and POST, because a git fetch POSTs to `git-upload-pack`, and
 * GitHub refuses a push with a read-only token.
 */
export const bindingsOf = (credential: HostCredential, value: string): CredentialBinding[] => {
  if (credential.kind === "github") {
    return [
      {
        name: `github:${GITHUB_GIT_HOST}`,
        host: GITHUB_GIT_HOST,
        header: "Authorization",
        value: basicOf("x-access-token", value),
        methods: ["GET", "HEAD", "POST"],
      },
    ];
  }
  if (credential.kind === "header") {
    return [
      {
        name: `header:${credential.host}`,
        host: credential.host,
        header: credential.headerName ?? "Authorization",
        value,
        ...(credential.pathPrefix === null ? {} : { path: credential.pathPrefix }),
        methods: READ_METHODS,
      },
    ];
  }
  // A registry with a token service hands the client a bearer token for each /v2/ request, and
  // the provider replaces a guest header of the same name. Basic on /v2/ would then replace that
  // bearer token, so only the token service gets the login. A registry with a Basic challenge
  // has no token service and takes the login on /v2/.
  const basic = basicOf(credential.username ?? "", value);
  if (credential.realmHost === null) {
    return [{ name: `registry:${credential.host}`, host: credential.host, header: "Authorization", value: basic, path: "/v2/", methods: READ_METHODS }];
  }
  return [
    {
      name: `registry:${credential.host}`,
      host: credential.realmHost,
      header: "Authorization",
      value: basic,
      ...(credential.realmPath === null || credential.realmPath === "" || credential.realmPath === "/" ? {} : { path: credential.realmPath }),
      methods: READ_METHODS,
    },
  ];
};

/** Mints the read-only token of a `github` credential, with enough time left to outlive the next rebind. */
export type GitHubGitTokenMinter = (installationId: string, repositories: readonly string[]) => Promise<string>;

export interface HostCredentialAccessDependencies {
  credentials: HostCredentialStore;
  secrets: Pick<SecretStore, "get">;
  githubToken: GitHubGitTokenMinter;
  /** The `owner/name` repositories of the product in one installation. A `github` token reads them too. */
  productRepositories: (tenantId: string, productId: string, installationId: string) => Promise<string[]>;
}

/** What a sandbox of the product needs: the hosts that join its egress and the bindings. */
export interface HostCredentialAccess {
  credentials: HostCredential[];
  hosts: string[];
  bindings: CredentialBinding[];
  /** True when a binding holds a `github` token, which the worker binds again before it expires. */
  refreshes: boolean;
}

export const NO_HOST_CREDENTIALS: HostCredentialAccess = { credentials: [], hosts: [], bindings: [], refreshes: false };

/**
 * Reads the credentials of one product and builds its bindings. It runs in an activity or the
 * worker, never in a workflow, so no value crosses a Temporal boundary. A stored secret that has
 * gone is a configuration fault, and the caller reports it.
 */
export const resolveHostCredentials = async (
  dependencies: HostCredentialAccessDependencies,
  tenantId: string,
  productId: string,
  /**
   * The `owner/name` repositories the sandbox checks out, such as a reference or a skills
   * repository. The binding replaces the clone token on github.com, so the token must read them.
   */
  checkoutRepositories: readonly string[] = [],
): Promise<HostCredentialAccess> => {
  const credentials = await dependencies.credentials.list(tenantId, productId);
  if (credentials.length === 0) return NO_HOST_CREDENTIALS;
  const bindings: CredentialBinding[] = [];
  let refreshes = false;
  for (const credential of credentials) {
    if (credential.kind === "github") {
      if (credential.githubInstallationId === null) throw new Error("the github host credential names no installation; save it again");
      const own = await dependencies.productRepositories(tenantId, productId, credential.githubInstallationId);
      const token = await dependencies.githubToken(
        credential.githubInstallationId,
        [...new Set([...credential.repositories, ...own, ...checkoutRepositories])].sort(),
      );
      bindings.push(...bindingsOf(credential, token));
      refreshes = true;
      continue;
    }
    const secret = await dependencies.secrets.get(tenantId, productId, hostCredentialSecretName(credential.host));
    if (secret === null || secret === "") throw new Error(`the host credential for ${credential.host} has no stored secret; enter it again on the product page`);
    bindings.push(...bindingsOf(credential, secret));
  }
  return { credentials, hosts: credentialHostsOf(credentials), bindings, refreshes };
};

/** The values the redactor must hold for one product: each secret and each Basic form a provider sends. */
export const redactionValuesOf = (credential: HostCredential, secret: string): string[] =>
  credential.kind === "registry" ? [secret, basicOf(credential.username ?? "", secret)] : [secret];

/** The anonymous challenge of `GET /v2/`: `Bearer realm="https://auth.docker.io/token",service=...`. */
export const realmOf = (challenge: string | null): { host: string; path: string } | null => {
  if (challenge === null) return null;
  const match = /realm="([^"]+)"/i.exec(challenge);
  if (match?.[1] === undefined) return null;
  try {
    const url = new URL(match[1]);
    if (url.protocol !== "https:") return null;
    return { host: url.hostname.toLowerCase(), path: url.pathname === "" ? "/" : url.pathname };
  } catch {
    return null;
  }
};
