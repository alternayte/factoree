import { describe, expect, it } from "vitest";
import { checkBase } from "~/domain/publishing/stale-base.js";
import type { RepositoryReader } from "~/adapters/github/git-repository-reader.js";

const reader = (sha: string): RepositoryReader => ({
  resolveRef: () => Promise.resolve(sha),
  listTree: () => Promise.resolve({ entries: [], truncated: false }),
  readBlob: () => Promise.resolve(null),
});

describe("checkBase", () => {
  it("is fresh when the target head equals the Run base SHA (SDD section 45)", async () => {
    const sha = "a".repeat(40);
    const result = await checkBase(reader(sha), { url: "https://github.com/o/r.git", branch: "main", runBaseSha: sha });
    expect(result.fresh).toBe(true);
    expect(result.currentTargetSha).toBe(sha);
  });

  it("is stale when the target head moved", async () => {
    const result = await checkBase(reader("b".repeat(40)), {
      url: "https://github.com/o/r.git",
      branch: "main",
      runBaseSha: "a".repeat(40),
    });
    expect(result.fresh).toBe(false);
  });

  it("refuses a Run base SHA that is not forty hexadecimal characters", async () => {
    await expect(
      checkBase(reader("a".repeat(40)), { url: "https://github.com/o/r.git", branch: "main", runBaseSha: "main" }),
    ).rejects.toThrow();
  });
});
