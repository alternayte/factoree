import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { buildImplementerInput } from "~/domain/runs/implementer-input.js";
import { DEFAULT_PROJECT_DEFAULTS } from "~/domain/runs/project-runtime-config.js";
import type { PreparedSandbox } from "~/domain/runs/sandbox-manager.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { FIXTURE_CONFIG, commitAll, initRepository } from "./support/fixture-repository.js";

/**
 * SDD section 64, AT-37. Repository and organization skills are discovered, each origin is
 * recorded, and a name conflict never overwrites a skill in silence.
 *
 * The test builds two real git repositories, prepares a real sandbox, and reads the rendered
 * skill lines. It then proves that the same lines reach the real Implementer prompt.
 */

/** Writes one `SKILL.md` with the frontmatter both fields, and creates every parent directory. */
const writeSkill = async (path: string, name: string, description: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\n\nThe body.\n`, "utf8");
};

describe("AT-37 — skill discovery", () => {
  let root: string;
  let sandboxRoot: string;
  let manager: SandboxManager;
  let prepared: PreparedSandbox;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-at37-repos-"));
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-at37-sandboxes-"));

    // The primary repository holds one skill in each of the three supported directory formats.
    const primary = join(root, "primary");
    await initRepository(primary);
    await mkdir(join(primary, ".factoree"), { recursive: true });
    await writeFile(join(primary, ".factoree", "config.yaml"), FIXTURE_CONFIG, "utf8");
    await writeFile(join(primary, "target.txt"), "original\n", "utf8");
    await writeSkill(join(primary, ".agents/skills/routes/SKILL.md"), "routes", "The repository route rules.");
    await writeSkill(join(primary, ".claude/skills/tests/SKILL.md"), "tests", "How to run the tests.");
    await writeSkill(join(primary, ".codex/skills/deploy/SKILL.md"), "deploy", "How to deploy the service.");
    // A README beside a skill is not a skill. Only a SKILL.md is one.
    await writeFile(join(primary, ".agents/skills/routes/README.md"), "Not a skill.\n", "utf8");
    await commitAll(primary, "initial");

    // The organization skills repository holds the same name once, and one distinct name.
    const organization = join(root, "org");
    await initRepository(organization);
    await writeSkill(
      join(organization, ".agents/skills/routes/SKILL.md"),
      "routes",
      "The organization route rules.",
    );
    await writeSkill(join(organization, ".agents/skills/security/SKILL.md"), "security", "The security rules.");
    await commitAll(organization, "initial");

    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    prepared = await manager.prepare({
      runId: "run-at37",
      tenantId: "tenant-1",
      projectId: "project-1",
      primary: { url: primary, ref: "main" },
      references: [],
      defaults: DEFAULT_PROJECT_DEFAULTS,
      organizationSkills: { url: organization, ref: "main" },
    });
  });

  afterAll(async () => {
    await manager.release(prepared);
    await rm(root, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("discovers every skill of both scopes, records the origin, and names both conflicting paths", () => {
    // SDD section 64, AT-37. Repository and organization skills are discovered.
    expect(prepared.skills.some((line) => line.startsWith("routes —"))).toBe(true);
    expect(prepared.skills.some((line) => line.startsWith("tests —"))).toBe(true);
    expect(prepared.skills.some((line) => line.startsWith("deploy —"))).toBe(true);
    expect(prepared.skills.some((line) => line.startsWith("security —"))).toBe(true);

    // SDD section 16. Origin is recorded. The repository line and the organization line differ.
    expect(prepared.skills.find((line) => line.startsWith("routes —"))).toContain("repository skill");
    expect(prepared.skills.find((line) => line.startsWith("security —"))).toContain("organization skill");

    // SDD section 16. A name conflict does not silently overwrite. Both paths reach the prompt.
    const conflict = prepared.skills.find((line) => line.startsWith('Name conflict: "routes"'));
    expect(conflict).toBeDefined();
    expect(conflict).toContain("organization-skills");
    expect(conflict).toContain("primary");

    // The README is no skill, so no line names it.
    expect(prepared.skills.some((line) => line.includes("README.md"))).toBe(false);
  });

  it("carries every skill line into the real Implementer prompt", () => {
    const built = buildImplementerInput({
      goal: "Replace the contents of target.txt.",
      humanDecisions: [],
      validationContract: null,
      contextContract: null,
      requiredContext: [],
      primaryRepositoryPath: prepared.checkout.primary.path,
      referenceRepositoryPaths: [],
      repositoryInstructions: prepared.repositoryInstructions,
      skills: prepared.skills,
      actionPolicy: buildActionPolicy(),
      repairFindings: [],
      projectTestSecrets: {},
    });

    for (const line of prepared.skills) expect(built.prompt).toContain(line);
    expect(built.prompt).toContain('Name conflict: "routes"');
    // SDD section 57. A skill overrides no higher rule, and the prompt says so.
    expect(built.prompt).toContain("SDD section 57 ranks a skill ninth");
  });
});
