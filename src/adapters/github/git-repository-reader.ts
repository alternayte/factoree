import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { withoutUrlCredentials } from "~/domain/runs/checkout.js";
import { credentialEnvironment } from "~/domain/security/git-credential-environment.js";
import type { GitHubTokenProvider } from "~/domain/products/github-token-provider.js";

const run = promisify(execFile);

/** One git read must not hang a Run. A slow mirror fails, and the caller decides the next step. */
export const GIT_READ_TIMEOUT_MS = 120_000;

/** SDD section 18 disables unbounded retrieval. A tree beyond this size is truncated. */
export const MAX_TREE_ENTRIES = 5_000;

/** A blob beyond this size never enters a prompt. See SDD section 18 and AT-09. */
export const MAX_BLOB_BYTES = 128 * 1024;

/** The largest output one git command can produce. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const SHA = /^[0-9a-f]{40}$/;

/**
 * Recognizes the `git cat-file` message for a path that does not exist at a given SHA. This
 * covers the two phrasings git uses: a path absent from the tree, and a `<sha>:<path>` object
 * name that a git version rejects outright.
 */
const isMissingObject = (stderr: string): boolean =>
  /does not exist/.test(stderr) ||
  /Not a valid object name/.test(stderr) ||
  /not a tree object/.test(stderr) ||
  /Invalid object name/.test(stderr);

export interface TreeEntry {
  path: string;
  sizeBytes: number;
}

export interface TreeListing {
  entries: TreeEntry[];
  /** True when the tree held more entries than `MAX_TREE_ENTRIES`. The value is never falsely false. */
  truncated: boolean;
}

/**
 * The read-only repository port of the context resolver. It runs on the control plane, before a
 * sandbox exists, so it must never execute repository code. Each method runs `git` only.
 */
export interface RepositoryReader {
  resolveRef(url: string, ref: string): Promise<string>;
  listTree(url: string, sha: string): Promise<TreeListing>;
  readBlob(url: string, sha: string, path: string): Promise<string | null>;
  /**
   * Runs `work` with a read-only credential source for one origin, so a private repository
   * resolves. Context discovery runs on the worker before the sandbox exists, so the sandbox
   * credential path cannot serve it. The credential belongs to the async context of `work`
   * only. Two Runs of two tenants that read at the same time on one worker never share it.
   * A null credential reads anonymously.
   */
  withCredential<T>(credential: RepositoryCredential | null, work: () => Promise<T>): Promise<T>;
}

/** The source of a read-only credential for one origin. It holds no token. */
export interface RepositoryCredential {
  origin: string;
  tokens: GitHubTokenProvider;
  githubInstallationId: string;
}

/**
 * Recognizes a git failure that repeats on every attempt. A repository that does not exist, a
 * ref that does not exist, and a rejected credential all give the same answer for ever. SDD
 * section 49 makes such a failure semantic, so the caller must not retry it. A timeout, a reset
 * connection, and a temporary DNS failure carry none of these phrases, so they stay retryable.
 */
export const isDeterministicRemoteFailure = (text: string): boolean =>
  /Repository not found/i.test(text) ||
  /does not appear to be a git repository/i.test(text) ||
  /remote branch .* not found/i.test(text) ||
  /Authentication failed/i.test(text) ||
  /could not read Username/i.test(text) ||
  /Permission denied/i.test(text) ||
  /access rights/i.test(text);

export class RepositoryReadError extends Error {
  /**
   * True when the same read fails the same way on every attempt. SDD section 49 forbids such a
   * failure to consume the infrastructure retry policy.
   */
  readonly deterministic: boolean;

  constructor(message: string, options?: { cause?: unknown; deterministic?: boolean }) {
    super(message, options);
    this.name = "RepositoryReadError";
    this.deterministic = options?.deterministic ?? false;
  }
}

/**
 * A stable directory name for one URL read under one installation. The URL itself can hold a
 * credential, so the reader hashes it. The installation is part of the key, so a mirror that one
 * tenant's credential fetched never answers a read under another installation.
 */
const mirrorKey = (installation: string, url: string): string =>
  createHash("sha256").update(`${installation}\n${url}`).digest("hex").slice(0, 32);

/** The `owner/repo` name of a GitHub repository URL, or null when the path names no repository. */
const repositoryNameOf = (url: URL): string | null => {
  const parts = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1] !== "" ? `${parts[0]}/${parts[1]}` : null;
};

/** Test-only knobs. Production uses the module constants. */
export interface GitRepositoryReaderOptions {
  /**
   * The tree entry ceiling. A test lowers it, because a fixture repository with the production
   * number of files is too slow to create. Production never sets it.
   */
  maxTreeEntries?: number;
}

export class GitRepositoryReader implements RepositoryReader {
  private root: string | null = null;
  private readonly mirrors = new Map<string, Promise<string>>();
  /** The credential source of the current async context. Never a token. */
  private readonly credential = new AsyncLocalStorage<RepositoryCredential | null>();
  private readonly maxTreeEntries: number;

  constructor(options: GitRepositoryReaderOptions = {}) {
    this.maxTreeEntries = options.maxTreeEntries ?? MAX_TREE_ENTRIES;
  }

  private workspace(): string {
    this.root ??= mkdtempSync(join(tmpdir(), "factoree-context-"));
    return this.root;
  }

  withCredential<T>(credential: RepositoryCredential | null, work: () => Promise<T>): Promise<T> {
    // Only the provider and the installation id are held. Neither is a credential, so this class
    // holds no token at any point outside the single command that mints and spends one.
    return this.credential.run(credential, work);
  }

  /**
   * The credential environment for one repository URL, or an empty environment when the current
   * context holds no credential for its origin. This method mints a fresh token immediately
   * before the git command that consumes it, scoped to read the one repository the URL names.
   * No token outlives the single command it authenticates.
   */
  private async credentialFor(url: string): Promise<Record<string, string>> {
    const source = this.credential.getStore();
    if (source === undefined || source === null) return {};
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {};
    }
    if (parsed.origin !== source.origin) return {};
    const repository = repositoryNameOf(parsed);
    // Read-only, and for this one repository. SDD section 30 forbids a write credential here, and
    // a token that reads every repository of the installation reads more than this command needs.
    const token = await source.tokens.tokenForInstallation(
      source.githubInstallationId,
      { contents: "read" },
      repository === null ? undefined : [repository],
    );
    return credentialEnvironment(`${source.origin}/`, token);
  }

  private async git(
    cwd: string | null,
    args: string[],
    subject: string,
    url?: string,
  ): Promise<string> {
    try {
      const credentialEnv = url === undefined ? {} : await this.credentialFor(url);
      const { stdout } = await run("git", args, {
        ...(cwd === null ? {} : { cwd }),
        timeout: GIT_READ_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
        // A private repository must fail immediately instead of a wait for a password. No
        // interactive helper runs.
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "true",
          GCM_INTERACTIVE: "never",
          ...credentialEnv,
        },
      });
      return stdout;
    } catch (error) {
      // SDD section 60. A clone URL can carry an access token, and that token is not a Project
      // secret. This removal is the only guard that keeps the token out of the message.
      throw new RepositoryReadError(withoutUrlCredentials(`${subject}: ${String(error)}`), {
        cause: error,
        deterministic: isDeterministicRemoteFailure(String(error)),
      });
    }
  }

  /**
   * Runs git and reports the outcome instead of a throw on a nonzero exit. A caller uses this
   * form when a nonzero exit can mean two different things, such as a legitimate "not found"
   * result and a genuine fault, and the caller must tell them apart.
   */
  private async gitResult(
    cwd: string,
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
      // This form reads the local mirror only, so it reaches no remote and needs no credential.
      const { stdout } = await run("git", args, {
        cwd,
        timeout: GIT_READ_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", GCM_INTERACTIVE: "never" },
      });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (error) {
      const asExecError = error as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: asExecError.code ?? 1,
        stdout: asExecError.stdout ?? "",
        stderr: asExecError.stderr ?? String(error),
      };
    }
  }

  /**
   * A bare mirror of one repository, created once per reader. `--filter=blob:none` fetches the
   * commits and the trees and leaves the blobs on the server until the reader reads one, so a
   * large repository costs a small download. SDD section 55 forbids a copy of a complete
   * repository into PostgreSQL, and this mirror sits in a temporary directory that `close` removes.
   */
  private mirror(url: string): Promise<string> {
    const key = mirrorKey(this.credential.getStore()?.githubInstallationId ?? "", url);
    const existing = this.mirrors.get(key);
    if (existing !== undefined) return existing;
    const path = join(this.workspace(), key);
    const creating = this.git(
      null,
      ["clone", "--bare", "--filter=blob:none", "--no-tags", url, path],
      `the mirror of ${withoutUrlCredentials(url)} could not be created`,
      url,
    ).then(() => path);
    // A failed clone must not stay in the cache, so a later call can try again.
    creating.catch(() => this.mirrors.delete(key));
    this.mirrors.set(key, creating);
    return creating;
  }

  async resolveRef(url: string, ref: string): Promise<string> {
    // `git ls-remote` cannot resolve a bare SHA. A SHA is already explicit.
    if (SHA.test(ref)) return ref;
    const stdout = await this.git(
      null,
      ["ls-remote", url, ref],
      `the ref "${ref}" of ${withoutUrlCredentials(url)} could not be resolved`,
      url,
    );
    const first = stdout.split("\n").find((line) => line.trim() !== "");
    const sha = first?.split(/\s+/)[0]?.trim() ?? "";
    if (!SHA.test(sha)) {
      // The remote answered, and it named no such ref. A retry asks the same question and
      // gets the same answer, so this failure is deterministic.
      throw new RepositoryReadError(
        `the ref "${ref}" of ${withoutUrlCredentials(url)} does not resolve to a commit SHA.`,
        { deterministic: true },
      );
    }
    return sha;
  }

  async listTree(url: string, sha: string): Promise<TreeListing> {
    const path = await this.mirror(url);
    const subject = `the tree of ${withoutUrlCredentials(url)} at ${sha} could not be listed`;
    // `-z` ends each record with a NUL byte instead of a newline, so git never quotes or
    // C-escapes a path. Without `-z`, a non-ASCII byte or a control character in a path comes
    // back rewritten, and a stored path then fails to match the real file at a later read.
    //
    // The reader consumes the output as a stream and stops at the entry ceiling. A buffered read
    // reaches its own byte ceiling first on a very large repository, and that ceiling throws
    // instead of a truncation. SDD section 18 requires the truncation, so the entry ceiling must
    // be the only limit the reader hits.
    const child = spawn("git", ["ls-tree", "-r", "-l", "-z", "--full-tree", sha], {
      cwd: path,
      // A private repository must fail immediately instead of a wait for a password. No
      // interactive helper runs.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", GCM_INTERACTIVE: "never" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const entries: TreeEntry[] = [];
    let truncated = false;
    let pending = "";
    let stderr = "";
    let stopped = false;

    const take = (record: string): void => {
      if (record === "") return;
      if (entries.length >= this.maxTreeEntries) {
        truncated = true;
        return;
      }
      // Format: `<mode> <type> <object> <size>\t<path>`. The path itself can hold a tab, so the
      // split stops at the first tab only, and everything after it is the path.
      const tab = record.indexOf("\t");
      if (tab < 0) return;
      const meta = record.slice(0, tab);
      const entryPath = record.slice(tab + 1);
      const size = meta.trim().split(/\s+/)[3] ?? "-";
      // A submodule entry reports its size as `-`, because a submodule has no blob of its own
      // in this repository. The reader excludes it, because there is no byte count to report.
      if (entryPath === "" || size === "-") return;
      entries.push({ path: entryPath, sizeBytes: Number.parseInt(size, 10) });
    };

    const outcome = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
      const timer = setTimeout(() => {
        stopped = true;
        child.kill("SIGKILL");
        resolve({ ok: false, detail: `the read timed out after ${GIT_READ_TIMEOUT_MS} ms` });
      }, GIT_READ_TIMEOUT_MS);

      const finish = (result: { ok: boolean; detail: string }): void => {
        clearTimeout(timer);
        resolve(result);
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        // The message stays bounded, because a caller only needs the reason.
        if (stderr.length < 8_192) stderr += chunk;
      });
      child.stdout.on("data", (chunk: string) => {
        if (stopped) return;
        pending += chunk;
        let cut = pending.indexOf("\0");
        while (cut >= 0) {
          take(pending.slice(0, cut));
          pending = pending.slice(cut + 1);
          cut = pending.indexOf("\0");
        }
        // The ceiling is reached, so the reader stops git rather than a read of the whole tree.
        if (truncated) {
          stopped = true;
          pending = "";
          child.kill("SIGTERM");
          finish({ ok: true, detail: "" });
        }
      });
      child.on("error", (error: Error) => {
        stopped = true;
        finish({ ok: false, detail: String(error) });
      });
      child.on("close", (code: number | null) => {
        if (stopped) return;
        // The last record of `-z` output also ends with a NUL byte, so `pending` is normally
        // empty here. A final record without one is still taken.
        take(pending);
        pending = "";
        if (code === 0) finish({ ok: true, detail: "" });
        else finish({ ok: false, detail: `git exited with code ${String(code)}: ${stderr.trim()}` });
      });
    });

    if (!outcome.ok) {
      // SDD section 60. A clone URL can carry an access token, and that token is not a Project
      // secret. This removal is the only guard that keeps the token out of the message.
      throw new RepositoryReadError(withoutUrlCredentials(`${subject}: ${outcome.detail}`));
    }
    return { entries, truncated };
  }

  async readBlob(url: string, sha: string, path: string): Promise<string | null> {
    const mirror = await this.mirror(url);
    const sizeResult = await this.gitResult(mirror, ["cat-file", "-s", `${sha}:${path}`]);
    if (sizeResult.exitCode !== 0) {
      // A missing path or an invalid object at this SHA is an ordinary discovery outcome, not a
      // fault, so it returns null rather than a throw. Every other failure, for example a
      // corrupt mirror or an exhausted output buffer, is a genuine fault and must throw.
      if (isMissingObject(sizeResult.stderr)) return null;
      throw new RepositoryReadError(
        withoutUrlCredentials(
          `the blob "${path}" of ${url} at ${sha} could not be read: ${sizeResult.stderr.trim()}`,
        ),
      );
    }
    const size = Number.parseInt(sizeResult.stdout.trim(), 10);
    // See AT-09. A large file stays tool-accessible in the sandbox and never enters a prompt.
    if (!Number.isFinite(size) || size > MAX_BLOB_BYTES) return null;
    const stdout = await this.git(
      mirror,
      ["cat-file", "blob", `${sha}:${path}`],
      `the blob "${path}" of ${withoutUrlCredentials(url)} at ${sha} could not be read`,
    );
    return stdout;
  }

  /** Removes every mirror. The caller owns the lifetime of the reader. */
  close(): void {
    const root = this.root;
    this.mirrors.clear();
    this.root = null;
    if (root !== null) rmSync(root, { recursive: true, force: true });
  }
}
