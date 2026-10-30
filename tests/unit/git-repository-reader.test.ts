import { describe, expect, it, vi } from "vitest";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";

/**
 * Records every `git` invocation this reader made, capturing the environment the credential
 * mint produced. `credentialFor` mints a token immediately before this call. This fake is the
 * seam that proves the mint happened at the right time, for the right installation, on every
 * call rather than once.
 */
const { calls, execFileImpl } = vi.hoisted(() => {
  const recorded: Array<{ args: string[]; env: Record<string, string> }> = [];
  const impl = (_file: string, args: string[], options: { env?: Record<string, string> }) => {
    recorded.push({ args, env: options.env ?? {} });
    return Promise.resolve({ stdout: `${"d".repeat(40)}\trefs/heads/main\n`, stderr: "" });
  };
  // `promisify(execFile)` runs at module load of the reader, against this mock. Node needs the
  // well-known custom symbol to name a function that already returns a Promise. The symbol is
  // attached here, before the reader module ever imports it.
  (impl as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] = impl;
  return { calls: recorded, execFileImpl: impl };
});

vi.mock("node:child_process", () => ({ execFile: execFileImpl, spawn: vi.fn() }));

/** Decodes the bearer identity `credentialEnvironment` placed on the git config override. */
const mintedIdentity = (env: Record<string, string>): string | null => {
  const header = env.GIT_CONFIG_VALUE_0;
  if (header === undefined) return null;
  const encoded = header.replace("Authorization: Basic ", "");
  return Buffer.from(encoded, "base64").toString("utf8");
};

const provider = (asked: Array<{ id: string; scope?: unknown; repositories?: readonly string[] }>) => ({
  tokenForInstallation: (id: string, scope?: unknown, repositories?: readonly string[]) => {
    asked.push({ id, scope, ...(repositories === undefined ? {} : { repositories }) });
    return Promise.resolve(`ghs_${id}_${asked.length}`);
  },
});

describe("GitRepositoryReader credential minting", () => {
  it("mints a token immediately before the git command that needs it", async () => {
    calls.length = 0;
    const asked: Array<{ id: string }> = [];
    const reader = new GitRepositoryReader();

    await reader.withCredential(
      { origin: "https://example.test", tokens: provider(asked), githubInstallationId: "111" },
      () => reader.resolveRef("https://example.test/o/r.git", "main"),
    );

    expect(asked.map((entry) => entry.id)).toEqual(["111"]);
    expect(mintedIdentity(calls[0]?.env ?? {})).toBe("x-access-token:ghs_111_1");
  });

  it("gives two Runs on one origin their own installation, even when they read at the same time", async () => {
    calls.length = 0;
    const asked: Array<{ id: string }> = [];
    const reader = new GitRepositoryReader();
    const tokens = provider(asked);

    // Both Runs read github.com. A credential held per origin let the later Run mint for the
    // earlier one. Each read must carry the installation of its own async context.
    await Promise.all([
      reader.withCredential({ origin: "https://example.test", tokens, githubInstallationId: "111" }, () =>
        reader.resolveRef("https://example.test/a/r.git", "main"),
      ),
      reader.withCredential({ origin: "https://example.test", tokens, githubInstallationId: "222" }, () =>
        reader.resolveRef("https://example.test/b/r.git", "main"),
      ),
    ]);

    const byRepository = new Map(
      calls.map((call) => [call.args.find((arg) => arg.startsWith("https://")) ?? "", mintedIdentity(call.env)]),
    );
    expect(byRepository.get("https://example.test/a/r.git")).toMatch(/^x-access-token:ghs_111_/);
    expect(byRepository.get("https://example.test/b/r.git")).toMatch(/^x-access-token:ghs_222_/);
  });

  it("reads anonymously outside a credential context", async () => {
    calls.length = 0;
    const asked: Array<{ id: string }> = [];
    const reader = new GitRepositoryReader();
    await reader.withCredential(
      { origin: "https://example.test", tokens: provider(asked), githubInstallationId: "111" },
      () => Promise.resolve(),
    );

    await reader.resolveRef("https://example.test/o/r.git", "main");

    expect(asked).toEqual([]);
    expect(mintedIdentity(calls[0]?.env ?? {})).toBeNull();
  });

  it("mints per call, not once, so a later call carries a fresh token", async () => {
    calls.length = 0;
    const asked: Array<{ id: string }> = [];
    const reader = new GitRepositoryReader();

    await reader.withCredential(
      { origin: "https://example.test", tokens: provider(asked), githubInstallationId: "111" },
      async () => {
        await reader.resolveRef("https://example.test/o/r.git", "main");
        await reader.resolveRef("https://example.test/o/r.git", "main");
      },
    );

    expect(asked.map((entry) => entry.id)).toEqual(["111", "111"]);
    expect(mintedIdentity(calls[0]?.env ?? {})).toBe("x-access-token:ghs_111_1");
    expect(mintedIdentity(calls[1]?.env ?? {})).toBe("x-access-token:ghs_111_2");
  });

  it("mints a read-only token for the one repository the command reads", async () => {
    calls.length = 0;
    const asked: Array<{ id: string; scope?: unknown; repositories?: readonly string[] }> = [];
    const reader = new GitRepositoryReader();

    await reader.withCredential(
      { origin: "https://example.test", tokens: provider(asked), githubInstallationId: "111" },
      () => reader.resolveRef("https://example.test/acme/api.git", "main"),
    );

    expect(asked).toEqual([{ id: "111", scope: { contents: "read" }, repositories: ["acme/api"] }]);
  });

  it("sends no credential to a URL on another origin", async () => {
    calls.length = 0;
    const asked: Array<{ id: string }> = [];
    const reader = new GitRepositoryReader();

    await reader.withCredential(
      { origin: "https://example.test", tokens: provider(asked), githubInstallationId: "111" },
      () => reader.resolveRef("https://elsewhere.test/o/r.git", "main"),
    );

    expect(asked).toEqual([]);
    expect(mintedIdentity(calls[0]?.env ?? {})).toBeNull();
  });
});
