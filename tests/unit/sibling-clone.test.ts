import { describe, expect, it } from "vitest";
import { buildSiblingCloner, SiblingCloneDeniedError } from "~/domain/runs/sibling-clone.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { FakeEvidenceStore } from "../support/fake-evidence-store.js";

const REPOSITORIES = [
  { id: "1", fullName: "acme/api", defaultBranch: "main", absentSince: null, githubInstallationId: "install-1" },
  { id: "2", fullName: "acme/web", defaultBranch: "main", absentSince: null, githubInstallationId: "install-1" },
];

const build = (overrides: { repositories?: typeof REPOSITORIES } = {}) => {
  const sandbox = new FakeSandbox();
  const evidence = new FakeEvidenceStore();
  sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
  const cloner = buildSiblingCloner({
    sandbox,
    ref: { id: "sbx-1", adapter: "fake", workspacePath: "/workspace" },
    evidence,
    tenantId: "tenant-1",
    repositories: overrides.repositories ?? REPOSITORIES,
    repositoryBaseUrl: "https://github.com",
  });
  return { sandbox, evidence, cloner };
};

describe("buildSiblingCloner", () => {
  it("clones a member repository read-only outside the target working tree", async () => {
    const { sandbox, cloner } = build();
    const result = await cloner.cloneSibling({ fullName: "acme/web", runId: "run-1", role: "implementer" });

    expect(result.path).not.toContain("/primary");
    expect(result.commitSha).toBe("aaaabbbbccccddddeeeeffff0000111122223333");
    const clones = sandbox.commands.filter((command) => command.args.includes("clone"));
    expect(clones).toHaveLength(1);
    expect(sandbox.commands.some((command) => command.file === "chmod" && command.args.includes(result.path))).toBe(
      true,
    );
  });

  it("writes an evidence record naming the repository, the commit, and the role", async () => {
    const { evidence, cloner } = build();

    await cloner.cloneSibling({ fullName: "acme/web", runId: "run-1", role: "implementer" });

    expect(evidence.rows).toHaveLength(1);
    const row = evidence.rows[0];
    expect(row?.kind).toBe("sibling_read");
    expect(row?.runId).toBe("run-1");
    expect(row?.metadata).toEqual({
      fullName: "acme/web",
      commitSha: "aaaabbbbccccddddeeeeffff0000111122223333",
      role: "implementer",
    });
  });

  it("denies a clone of a repository outside the Product, and clones nothing", async () => {
    const { sandbox, evidence, cloner } = build();

    await expect(
      cloner.cloneSibling({ fullName: "acme/other", runId: "run-1", role: "implementer" }),
    ).rejects.toThrow(SiblingCloneDeniedError);
    expect(sandbox.commands.filter((command) => command.args.includes("clone"))).toHaveLength(0);
    expect(evidence.rows).toHaveLength(0);
  });
});
