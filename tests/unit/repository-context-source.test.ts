import { describe, expect, it } from "vitest";
import { RepositoryContextSource, classifyPath } from "~/domain/context/repository-source.js";
import type { ContextDiscoveryRequest } from "~/domain/context/context-source.js";
import type { RepositoryReader } from "~/adapters/github/git-repository-reader.js";
import {
  RepositoryReadError,
  isDeterministicRemoteFailure,
} from "~/adapters/github/git-repository-reader.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import { FakeRepositoryReader } from "../support/fake-repository-reader.js";

const PRIMARY_URL = "https://git/acme/webhook-service";
const REFERENCE_URL = "https://git/acme/notification-service";

const files = {
  ".factoree/config.yaml": "version: 1\nverify:\n  commands:\n    - name: test\n      run: npm test\n",
  "README.md": "# Webhook service\n",
  "docs/ADR-031.md": "# ADR 31\n\nStatus: accepted\n",
  "docs/overview.md": "An overview.\n",
  "openapi.yaml": "openapi: 3.1.0\n",
  "src/retry.ts": "export const retry = () => undefined;\n",
  "src/unrelated.ts": "export const other = () => undefined;\n",
  "tests/retry.test.ts": "it('retries', () => undefined);\n",
  "LICENSE": "MIT\n",
};

const reader = () =>
  new FakeRepositoryReader({
    [PRIMARY_URL]: { sha: "a".repeat(40), files },
    [REFERENCE_URL]: { sha: "b".repeat(40), files: { "openapi.yaml": "openapi: 3.1.0\n" } },
  });

const request = (over: Partial<ContextDiscoveryRequest> = {}): ContextDiscoveryRequest => ({
  runId: "run-1",
  goal: "Retry webhook deliveries.",
  topics: ["deliveries", "retry", "webhook"],
  primaryRepository: { slug: "acme/webhook-service", url: PRIMARY_URL, ref: "main" },
  referenceRepositories: [{ slug: "acme/notification-service", url: REFERENCE_URL, ref: "main" }],
  workItemReferences: [],
  decisions: [],
  ...over,
});

describe("classifyPath", () => {
  it("classifies the repository configuration", () => {
    expect(classifyPath(".factoree/config.yaml")?.authority).toBe("repository_configuration");
  });

  it("classifies an ADR under a decisions directory", () => {
    expect(classifyPath("docs/decisions/0007-queue.md")?.authority).toBe("accepted_adr");
  });

  it("classifies an ADR by its file name", () => {
    expect(classifyPath("docs/ADR-031.md")?.authority).toBe("accepted_adr");
  });

  it("classifies a machine readable contract", () => {
    expect(classifyPath("openapi.yaml")?.authority).toBe("machine_readable_contract");
    expect(classifyPath("api/events.proto")?.authority).toBe("machine_readable_contract");
  });

  it("classifies an executable test", () => {
    expect(classifyPath("tests/retry.test.ts")?.authority).toBe("executable_tests");
    expect(classifyPath("src/retry.spec.ts")?.authority).toBe("executable_tests");
  });

  it("classifies the root README", () => {
    expect(classifyPath("README.md")?.authority).toBe("repository_readme");
  });

  it("classifies a nested README as documentation, not as the repository README", () => {
    expect(classifyPath("docs/README.md")?.authority).toBe("architecture_documentation");
  });

  it("classifies other repository documentation", () => {
    expect(classifyPath("docs/overview.md")?.authority).toBe("architecture_documentation");
  });

  it("classifies a source file", () => {
    expect(classifyPath("src/retry.ts")?.authority).toBe("source_code");
  });

  it("classifies nothing else", () => {
    expect(classifyPath("LICENSE")).toBeNull();
    expect(classifyPath("assets/logo.png")).toBeNull();
  });
});

describe("RepositoryContextSource", () => {
  it("identifies itself as repository", () => {
    expect(new RepositoryContextSource({ reader: reader() }).id()).toBe("repository");
  });

  it("pins every repository to an explicit SHA", async () => {
    const candidates = await new RepositoryContextSource({ reader: reader() }).discover(request());
    const shas = new Set(candidates.map((candidate) => candidate.reference.sha));
    expect([...shas].sort()).toEqual(["a".repeat(40), "b".repeat(40)]);
    for (const candidate of candidates) expect(candidate.sourceVersion).toMatch(/^[0-9a-f]{40}$/);
  });

  it("offers the primary repository as a required item", async () => {
    const candidates = await new RepositoryContextSource({ reader: reader() }).discover(request());
    const repository = candidates.find(
      (candidate) => candidate.reference.ref === "repository:acme/webhook-service",
    );
    expect(repository?.suggestedClassification).toBe("required");
    expect(repository?.reference.path).toBeNull();
    expect(repository?.reason).toBe("the primary repository of the Project");
  });

  it("offers a reference repository as a reference item", async () => {
    const candidates = await new RepositoryContextSource({ reader: reader() }).discover(request());
    const repository = candidates.find(
      (candidate) => candidate.reference.ref === "repository:acme/notification-service",
    );
    expect(repository?.suggestedClassification).toBe("reference");
    expect(repository?.reason).toBe("a configured reference repository");
  });

  it("offers a source file only when it carries a Work Item topic", async () => {
    const candidates = await new RepositoryContextSource({ reader: reader() }).discover(request());
    const refs = candidates.map((candidate) => candidate.reference.ref);
    expect(refs).toContain("repository:acme/webhook-service:src/retry.ts");
    expect(refs).not.toContain("repository:acme/webhook-service:src/unrelated.ts");
  });

  it("offers a source file from the primary repository only", async () => {
    const withSource = new FakeRepositoryReader({
      [PRIMARY_URL]: { sha: "a".repeat(40), files: {} },
      [REFERENCE_URL]: { sha: "b".repeat(40), files: { "src/retry.ts": "x" } },
    });
    const candidates = await new RepositoryContextSource({ reader: withSource }).discover(request());
    expect(candidates.map((candidate) => candidate.reference.ref)).not.toContain(
      "repository:acme/notification-service:src/retry.ts",
    );
  });

  it("records the topics a path carries", async () => {
    const candidates = await new RepositoryContextSource({ reader: reader() }).discover(request());
    const file = candidates.find(
      (candidate) => candidate.reference.ref === "repository:acme/webhook-service:src/retry.ts",
    );
    expect(file?.topics).toEqual(["retry"]);
  });

  it("records the size of each path from the tree", async () => {
    const candidates = await new RepositoryContextSource({ reader: reader() }).discover(request());
    const readme = candidates.find(
      (candidate) => candidate.reference.ref === "repository:acme/webhook-service:README.md",
    );
    expect(readme?.sizeBytes).toBe(Buffer.byteLength(files["README.md"], "utf8"));
  });

  it("reports a truncated tree in the reason of the repository item", async () => {
    const truncating = new FakeRepositoryReader({
      [PRIMARY_URL]: { sha: "a".repeat(40), files, truncated: true },
      [REFERENCE_URL]: { sha: "b".repeat(40), files: {}, truncated: false },
    });
    const candidates = await new RepositoryContextSource({ reader: truncating }).discover(request());
    const repository = candidates.find(
      (candidate) => candidate.reference.ref === "repository:acme/webhook-service",
    );
    expect(repository?.reason).toMatch(/truncated/);
  });

  it("reads a blob at the pinned SHA", async () => {
    const source = new RepositoryContextSource({ reader: reader() });
    await source.discover(request());
    const document = await source.fetch({
      sourceId: "repository",
      ref: "repository:acme/webhook-service:docs/ADR-031.md",
      repository: "acme/webhook-service",
      sha: "a".repeat(40),
      path: "docs/ADR-031.md",
    });
    expect(document.content).toContain("Status: accepted");
    expect(document.sourceVersion).toBe("a".repeat(40));
  });

  it("fails when a selected blob cannot be read", async () => {
    const source = new RepositoryContextSource({ reader: reader() });
    await source.discover(request());
    await expect(
      source.fetch({
        sourceId: "repository",
        ref: "repository:acme/webhook-service:absent.md",
        repository: "acme/webhook-service",
        sha: "a".repeat(40),
        path: "absent.md",
      }),
    ).rejects.toThrow(/absent\.md/);
  });

  /** A reader whose `resolveRef` fails with the given error. Discovery must classify it. */
  const failingReader = (error: Error): RepositoryReader => {
    const base = reader();
    return {
      resolveRef: () => Promise.reject(error),
      listTree: (url: string, sha: string) => base.listTree(url, sha),
      readBlob: (url: string, sha: string, path: string) => base.readBlob(url, sha, path),
    };
  };

  it("reports a ref that resolves to nothing as a Run configuration fault", async () => {
    // SDD section 49. The failure repeats on every attempt, so it must drive a workflow
    // decision instead of the infrastructure retry policy.
    const source = new RepositoryContextSource({
      reader: failingReader(
        new RepositoryReadError('the ref "main" of https://git/acme/webhook-service does not resolve to a commit SHA.', {
          deterministic: true,
        }),
      ),
    });
    await expect(source.discover(request())).rejects.toBeInstanceOf(RunConfigurationError);
  });

  it("keeps a transport fault retryable", async () => {
    // A timeout against a reachable host can succeed on the next attempt, so it must stay an
    // ordinary read error.
    const source = new RepositoryContextSource({
      reader: failingReader(
        new RepositoryReadError("the ref \"main\" could not be resolved: the read timed out after 120000 ms"),
      ),
    });
    await expect(source.discover(request())).rejects.toBeInstanceOf(RepositoryReadError);
    await expect(source.discover(request())).rejects.not.toBeInstanceOf(RunConfigurationError);
  });

  it("names a repository that does not exist as a deterministic failure", () => {
    expect(isDeterministicRemoteFailure("remote: Repository not found.")).toBe(true);
    expect(isDeterministicRemoteFailure("fatal: Authentication failed for 'https://git/x'")).toBe(
      true,
    );
    // A timeout and a reset connection are transport faults, so they stay retryable.
    expect(isDeterministicRemoteFailure("Command failed: git ls-remote\nkilled SIGTERM")).toBe(
      false,
    );
    expect(isDeterministicRemoteFailure("fatal: unable to access: Connection reset by peer")).toBe(
      false,
    );
  });

  it("exposes the pinned SHA of every repository after discovery", async () => {
    const source = new RepositoryContextSource({ reader: reader() });
    await source.discover(request());
    expect(source.pinnedShas()).toEqual({
      "acme/webhook-service": "a".repeat(40),
      "acme/notification-service": "b".repeat(40),
    });
  });
});
