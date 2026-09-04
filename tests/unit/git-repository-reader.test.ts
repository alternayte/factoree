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

describe("GitRepositoryReader credential minting", () => {
  it("mints a token immediately before the git command that needs it", async () => {
    calls.length = 0;
    const asked: string[] = [];
    const reader = new GitRepositoryReader();
    reader.useCredential(
      "https://example.test",
      { tokenForInstallation: (id: string) => {
        asked.push(id);
        return Promise.resolve(`ghs_${id}`);
      } },
      "111",
    );

    await reader.resolveRef("https://example.test/o/r.git", "main");

    expect(asked).toEqual(["111"]);
    expect(mintedIdentity(calls[0]?.env ?? {})).toBe("x-access-token:ghs_111");
  });

  it("mints against each installation's own id, and neither call receives the other's token", async () => {
    calls.length = 0;
    const asked: string[] = [];
    const reader = new GitRepositoryReader();
    reader.useCredential(
      "https://a.test",
      { tokenForInstallation: (id: string) => {
        asked.push(id);
        return Promise.resolve(`ghs_${id}`);
      } },
      "111",
    );
    reader.useCredential(
      "https://b.test",
      { tokenForInstallation: (id: string) => {
        asked.push(id);
        return Promise.resolve(`ghs_${id}`);
      } },
      "222",
    );

    await reader.resolveRef("https://a.test/o/r.git", "main");
    await reader.resolveRef("https://b.test/o/r.git", "main");

    expect(asked).toEqual(["111", "222"]);
    expect(mintedIdentity(calls[0]?.env ?? {})).toBe("x-access-token:ghs_111");
    expect(mintedIdentity(calls[1]?.env ?? {})).toBe("x-access-token:ghs_222");
    expect(mintedIdentity(calls[1]?.env ?? {})).not.toBe(mintedIdentity(calls[0]?.env ?? {}));
  });

  it("mints per call, not once, so a later call carries a fresh token", async () => {
    calls.length = 0;
    const asked: string[] = [];
    let mintCount = 0;
    const reader = new GitRepositoryReader();
    reader.useCredential(
      "https://example.test",
      { tokenForInstallation: (id: string) => {
        asked.push(id);
        mintCount += 1;
        return Promise.resolve(`ghs_${id}_${mintCount}`);
      } },
      "111",
    );

    await reader.resolveRef("https://example.test/o/r.git", "main");
    await reader.resolveRef("https://example.test/o/r.git", "main");

    // Two calls, two mints. A future change that caches the resolved environment on
    // `credentialSources` and mints once leaves `asked` at length one. That change fails here.
    expect(asked).toEqual(["111", "111"]);
    const first = mintedIdentity(calls[0]?.env ?? {});
    const second = mintedIdentity(calls[1]?.env ?? {});
    expect(first).toBe("x-access-token:ghs_111_1");
    expect(second).toBe("x-access-token:ghs_111_2");
    expect(second).not.toBe(first);
  });

  it("mints a read-only scope, never a write scope. Ruling 2 forbids a write credential here", async () => {
    calls.length = 0;
    const scopes: Array<Record<string, string> | undefined> = [];
    const reader = new GitRepositoryReader();
    reader.useCredential(
      "https://example.test",
      {
        tokenForInstallation: (id: string, scope?: Record<string, string>) => {
          scopes.push(scope);
          return Promise.resolve(`ghs_${id}`);
        },
      },
      "111",
    );

    await reader.resolveRef("https://example.test/o/r.git", "main");

    expect(scopes).toEqual([{ contents: "read" }]);
  });
});
