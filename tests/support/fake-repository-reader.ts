import type {
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

  constructor(private readonly repositories: Record<string, FakeRepository>) {}

  useCredential(origin: string): void {
    this.credentialOrigins.push(origin);
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
      entries: Object.entries(repository.files).map(([path, content]) => ({
        path,
        sizeBytes: Buffer.byteLength(content, "utf8"),
      })),
      truncated: repository.truncated === true,
    });
  }

  readBlob(url: string, sha: string, path: string): Promise<string | null> {
    this.calls.push(`readBlob ${url} ${sha} ${path}`);
    return Promise.resolve(this.repository(url).files[path] ?? null);
  }
}
