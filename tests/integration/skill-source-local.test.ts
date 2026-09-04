import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { discoverSkills } from "~/domain/runs/skill-source.js";
import type { SandboxRef } from "~/domain/runs/sandbox.js";

describe("discoverSkills against a real sandbox", () => {
  let root: string;
  let sandbox: LocalProcessSandbox;
  let ref: SandboxRef;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-skills-"));
    sandbox = new LocalProcessSandbox({ rootDirectory: root });
    ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const writeSkill = async (base: string, directory: string, name: string, body: string): Promise<void> => {
    const target = join(ref.workspacePath, base, directory, name);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), body, "utf8");
  };

  it("discovers a repository skill and an organization skill, and reports the conflict", async () => {
    await writeSkill("primary", ".agents/skills", "routes", "---\nname: routes\ndescription: repo.\n---\n");
    await writeSkill("primary", ".claude/skills", "tests", "---\nname: tests\ndescription: repo tests.\n---\n");
    await writeSkill("organization-skills", ".agents/skills", "routes", "---\nname: routes\ndescription: org.\n---\n");
    await writeSkill("organization-skills", ".codex/skills", "deploy", "---\nname: deploy\ndescription: org deploy.\n---\n");

    const set = await discoverSkills(sandbox, ref, [
      { scope: "repository", path: join(ref.workspacePath, "primary") },
      { scope: "organization", path: join(ref.workspacePath, "organization-skills") },
    ]);

    expect(set.skills.map((entry) => entry.name).sort()).toEqual(["deploy", "routes", "tests"]);
    const routes = set.skills.find((entry) => entry.name === "routes");
    expect(routes?.description).toBe("repo.");
    expect(routes?.origin.scope).toBe("repository");
    expect(set.conflicts).toHaveLength(1);
    expect(set.conflicts[0]?.name).toBe("routes");
    expect(set.conflicts[0]?.shadowed[0]?.scope).toBe("organization");
  });

  it("reports nothing for a checkout that holds no skill directory", async () => {
    await mkdir(join(ref.workspacePath, "primary"), { recursive: true });
    const set = await discoverSkills(sandbox, ref, [
      { scope: "repository", path: join(ref.workspacePath, "primary") },
    ]);
    expect(set.skills).toEqual([]);
  });
});
