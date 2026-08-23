import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { withoutUrlCredentials } from "~/domain/runs/checkout.js";

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
}

export class RepositoryReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RepositoryReadError";
  }
}

/** A stable directory name for one URL. The URL itself can hold a credential, so the reader hashes it. */
const mirrorName = (url: string): string => createHash("sha256").update(url).digest("hex").slice(0, 32);

export class GitRepositoryReader implements RepositoryReader {
  private root: string | null = null;
  private readonly mirrors = new Map<string, Promise<string>>();

  private workspace(): string {
    this.root ??= mkdtempSync(join(tmpdir(), "factoree-context-"));
    return this.root;
  }

  private async git(cwd: string | null, args: string[], subject: string): Promise<string> {
    try {
      const { stdout } = await run("git", args, {
        ...(cwd === null ? {} : { cwd }),
        timeout: GIT_READ_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
        // A private repository must fail immediately instead of a wait for a password. No
        // interactive helper runs.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", GCM_INTERACTIVE: "never" },
      });
      return stdout;
    } catch (error) {
      // SDD section 60. A clone URL can carry an access token, and that token is not a Project
      // secret. This removal is the only guard that keeps the token out of the message.
      throw new RepositoryReadError(withoutUrlCredentials(`${subject}: ${String(error)}`), {
        cause: error,
      });
    }
  }

  /**
   * A bare mirror of one repository, created once per reader. `--filter=blob:none` fetches the
   * commits and the trees and leaves the blobs on the server until the reader reads one, so a
   * large repository costs a small download. SDD section 55 forbids a copy of a complete
   * repository into PostgreSQL, and this mirror sits in a temporary directory that `close` removes.
   */
  private mirror(url: string): Promise<string> {
    const existing = this.mirrors.get(url);
    if (existing !== undefined) return existing;
    const path = join(this.workspace(), mirrorName(url));
    const creating = this.git(
      null,
      ["clone", "--bare", "--filter=blob:none", "--no-tags", url, path],
      `the mirror of ${withoutUrlCredentials(url)} could not be created`,
    ).then(() => path);
    // A failed clone must not stay in the cache, so a later call can try again.
    creating.catch(() => this.mirrors.delete(url));
    this.mirrors.set(url, creating);
    return creating;
  }

  async resolveRef(url: string, ref: string): Promise<string> {
    // `git ls-remote` cannot resolve a bare SHA. A SHA is already explicit.
    if (SHA.test(ref)) return ref;
    const stdout = await this.git(
      null,
      ["ls-remote", url, ref],
      `the ref "${ref}" of ${withoutUrlCredentials(url)} could not be resolved`,
    );
    const first = stdout.split("\n").find((line) => line.trim() !== "");
    const sha = first?.split(/\s+/)[0]?.trim() ?? "";
    if (!SHA.test(sha)) {
      throw new RepositoryReadError(
        `the ref "${ref}" of ${withoutUrlCredentials(url)} does not resolve to a commit SHA.`,
      );
    }
    return sha;
  }

  async listTree(url: string, sha: string): Promise<TreeListing> {
    const path = await this.mirror(url);
    const stdout = await this.git(
      path,
      ["ls-tree", "-r", "-l", "--full-tree", sha],
      `the tree of ${withoutUrlCredentials(url)} at ${sha} could not be listed`,
    );
    const entries: TreeEntry[] = [];
    let truncated = false;
    for (const line of stdout.split("\n")) {
      if (line.trim() === "") continue;
      if (entries.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        break;
      }
      // Format: `<mode> <type> <object> <size>\t<path>`. The size field is `-` for a submodule.
      const [meta, entryPath] = line.split("\t");
      const size = meta?.trim().split(/\s+/)[3] ?? "-";
      if (entryPath === undefined || entryPath === "" || size === "-") continue;
      entries.push({ path: entryPath, sizeBytes: Number.parseInt(size, 10) });
    }
    return { entries, truncated };
  }

  async readBlob(url: string, sha: string, path: string): Promise<string | null> {
    const mirror = await this.mirror(url);
    let size: number;
    try {
      const stdout = await this.git(mirror, ["cat-file", "-s", `${sha}:${path}`], "size");
      size = Number.parseInt(stdout.trim(), 10);
    } catch {
      // The path does not exist at that SHA. This is an ordinary discovery outcome, not a fault.
      return null;
    }
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
