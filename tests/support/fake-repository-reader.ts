import type {
  RepositoryCredential,
  RepositoryReader,
  TreeListing,
} from "~/adapters/github/git-repository-reader.js";
import { RepositoryReadError } from "~/adapters/github/git-repository-reader.js";

export interface FakeRepository {
  sha: string;
  files: Record<string, string>;
  truncated?: boolean;
}

/** An in-memory `RepositoryReader`. A unit test uses it, so no git process runs. */
export class FakeRepositoryReader implements RepositoryReader {
  readonly calls: string[] = [];

  /** The origins a caller supplied a credential for. A test asserts on the names, never a value. */
  readonly credentialOrigins: string[] = [];

  /** Every token this fake minted, standing in for the git command a real reader would run. */
  readonly mintedTokens: string[] = [];

  constructor(private readonly repositories: Record<string, FakeRepository>) {}

  async withCredential<T>(credential: RepositoryCredential | null, work: () => Promise<T>): Promise<T> {
    if (credential !== null) {
      this.credentialOrigins.push(credential.origin);
      // A real reader mints immediately before the git command that spends the token. This fake
      // runs no git command, so it mints once here instead, to stand in for that command.
      this.mintedTokens.push(await credential.tokens.tokenForInstallation(credential.githubInstallationId));
    }
    return work();
  }

  private repository(url: string): FakeRepository {
    const repository = this.repositories[url];
    if (repository === undefined) throw new RepositoryReadError(`no fake repository at ${url}`);
    return repository;
  }

  resolveRef(url: string, ref: string): Promise<string> {
    this.calls.push(`resolveRef ${url} ${ref}`);
    return Promise.resolve(this.repository(url).sha);
  }

  listTree(url: string, sha: string): Promise<TreeListing> {
    this.calls.push(`listTree ${url} ${sha}`);
    const repository = this.repository(url);
    return Promise.resolve({
      // The fake names each blob by its path.
      entries: Object.keys(repository.files).map((path) => ({ path, objectId: path })),
      truncated: repository.truncated === true,
    });
  }

  blobSizes(url: string, objectIds: readonly string[]): Promise<Map<string, number>> {
    this.calls.push(`blobSizes ${url} ${String(objectIds.length)}`);
    const files = this.repository(url).files;
    const sizes = new Map<string, number>();
    for (const id of objectIds) {
      const content = files[id];
      if (content !== undefined) sizes.set(id, Buffer.byteLength(content, "utf8"));
    }
    return Promise.resolve(sizes);
  }

  readBlob(url: string, sha: string, path: string): Promise<string | null> {
    this.calls.push(`readBlob ${url} ${sha} ${path}`);
    return Promise.resolve(this.repository(url).files[path] ?? null);
  }
}
