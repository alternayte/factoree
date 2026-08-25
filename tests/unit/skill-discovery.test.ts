import { describe, expect, it } from "vitest";
import {
  MAX_SKILLS,
  parseSkillDocument,
  renderSkillLines,
  resolveSkills,
  SKILL_DIRECTORIES,
  type DiscoveredSkill,
  type SkillOrigin,
} from "~/domain/runs/skill-discovery.js";

const origin = (overrides: Partial<SkillOrigin> = {}): SkillOrigin => ({
  scope: "repository",
  root: "/w/primary",
  directory: ".agents/skills",
  name: "fastify-routes",
  path: "/w/primary/.agents/skills/fastify-routes/SKILL.md",
  ...overrides,
});

const skill = (name: string, over: Partial<SkillOrigin> = {}): DiscoveredSkill => ({
  name,
  description: `the ${name} skill`,
  origin: origin({ name, path: `/w/primary/.agents/skills/${name}/SKILL.md`, ...over }),
});

describe("SKILL_DIRECTORIES", () => {
  it("names the three formats of SDD section 16, in precedence order", () => {
    expect([...SKILL_DIRECTORIES]).toEqual([".agents/skills", ".claude/skills", ".codex/skills"]);
  });
});

describe("parseSkillDocument", () => {
  it("reads the name and the description from the frontmatter", () => {
    const parsed = parseSkillDocument("---\nname: routes\ndescription: How to add a route.\n---\nbody\n", origin());
    expect(parsed.name).toBe("routes");
    expect(parsed.description).toBe("How to add a route.");
  });

  it("falls back to the directory name when the frontmatter has no name", () => {
    const parsed = parseSkillDocument("---\ndescription: Only a description.\n---\n", origin());
    expect(parsed.name).toBe("fastify-routes");
  });

  it("falls back to the directory name when the document has no frontmatter", () => {
    const parsed = parseSkillDocument("# A skill\n\nSome text.\n", origin());
    expect(parsed.name).toBe("fastify-routes");
    expect(parsed.description).toBe("");
  });

  it("falls back to the directory name when the frontmatter is not valid YAML", () => {
    const parsed = parseSkillDocument("---\nname: [unclosed\n---\n", origin());
    expect(parsed.name).toBe("fastify-routes");
  });

  it("falls back to the directory name when the frontmatter name is not a usable name", () => {
    const parsed = parseSkillDocument("---\nname: 42\n---\n", origin());
    expect(parsed.name).toBe("fastify-routes");
  });

  it("collapses a description onto one line, because a newline breaks a prompt list", () => {
    const parsed = parseSkillDocument("---\ndescription: |\n  first\n  second\n---\n", origin());
    expect(parsed.description).toBe("first second");
  });

  it("truncates a very long description", () => {
    const parsed = parseSkillDocument(`---\ndescription: ${"a".repeat(600)}\n---\n`, origin());
    expect(parsed.description.length).toBeLessThanOrEqual(303);
    expect(parsed.description.endsWith("...")).toBe(true);
  });

  it("keeps the origin it was given", () => {
    const given = origin({ scope: "organization" });
    expect(parseSkillDocument("---\nname: routes\n---\n", given).origin).toEqual(given);
  });
});

describe("resolveSkills", () => {
  it("keeps a single skill and reports no conflict", () => {
    const set = resolveSkills([skill("routes")]);
    expect(set.skills.map((entry) => entry.name)).toEqual(["routes"]);
    expect(set.conflicts).toEqual([]);
  });

  it("sorts the applied skills by name", () => {
    const set = resolveSkills([skill("zebra"), skill("alpha")]);
    expect(set.skills.map((entry) => entry.name)).toEqual(["alpha", "zebra"]);
  });

  it("applies the first candidate of a name and records the rest as shadowed", () => {
    const first = skill("routes");
    const second: DiscoveredSkill = {
      name: "routes",
      description: "the organization version",
      origin: origin({ scope: "organization", root: "/w/organization-skills", name: "routes",
        path: "/w/organization-skills/.agents/skills/routes/SKILL.md" }),
    };
    const set = resolveSkills([first, second]);
    expect(set.skills).toHaveLength(1);
    expect(set.skills[0]?.origin.scope).toBe("repository");
    expect(set.conflicts).toHaveLength(1);
    expect(set.conflicts[0]?.name).toBe("routes");
    expect(set.conflicts[0]?.applied.scope).toBe("repository");
    expect(set.conflicts[0]?.shadowed.map((entry) => entry.scope)).toEqual(["organization"]);
  });

  it("records every shadowed origin when a name appears three times", () => {
    const set = resolveSkills([
      skill("routes"),
      skill("routes", { directory: ".claude/skills", path: "/w/primary/.claude/skills/routes/SKILL.md" }),
      skill("routes", { directory: ".codex/skills", path: "/w/primary/.codex/skills/routes/SKILL.md" }),
    ]);
    expect(set.skills).toHaveLength(1);
    expect(set.conflicts[0]?.shadowed).toHaveLength(2);
  });

  it("caps the applied skills and reports the number it dropped", () => {
    const many = Array.from({ length: MAX_SKILLS + 5 }, (_value, index) =>
      skill(`skill-${String(index).padStart(3, "0")}`),
    );
    const set = resolveSkills(many);
    expect(set.skills).toHaveLength(MAX_SKILLS);
    expect(set.droppedForLimit).toBe(5);
  });

  it("reports a conflict even when the cap drops the conflicted name", () => {
    // Fifty distinct names fill the cap. The fifty-first name is new, so it is the one the cap
    // drops. A second candidate of that same name still arrives, so the dropped name also
    // conflicts. SDD section 16 requires the report to name it anyway.
    const filling = Array.from({ length: MAX_SKILLS }, (_value, index) =>
      skill(`skill-${String(index).padStart(3, "0")}`),
    );
    const droppedName = "skill-050";
    const set = resolveSkills([
      ...filling,
      skill(droppedName),
      skill(droppedName, { directory: ".claude/skills", path: `/w/primary/.claude/skills/${droppedName}/SKILL.md` }),
    ]);
    expect(set.skills.some((entry) => entry.name === droppedName)).toBe(false);
    expect(set.droppedForLimit).toBe(1);
    const conflict = set.conflicts.find((entry) => entry.name === droppedName);
    expect(conflict).toBeDefined();
    expect(conflict?.shadowed).toHaveLength(1);
  });

  it("applies the cap in precedence order, so a repository skill never loses its place to an organization skill", () => {
    // Repository names sort late. Organization names sort early. The candidate order below is
    // already precedence order: every repository candidate precedes every organization candidate.
    const repositorySkills = Array.from({ length: MAX_SKILLS }, (_value, index) =>
      skill(`zzz-repo-${String(index).padStart(3, "0")}`, { scope: "repository" }),
    );
    const organizationSkills = Array.from({ length: 5 }, (_value, index) =>
      skill(`aaa-org-${String(index).padStart(3, "0")}`, {
        scope: "organization",
        root: "/w/organization-skills",
        path: `/w/organization-skills/.agents/skills/aaa-org-${String(index).padStart(3, "0")}/SKILL.md`,
      }),
    );
    const set = resolveSkills([...repositorySkills, ...organizationSkills]);
    expect(set.skills).toHaveLength(MAX_SKILLS);
    expect(set.skills.every((entry) => entry.origin.scope === "repository")).toBe(true);
    expect(set.droppedForLimit).toBe(5);
  });
});

describe("renderSkillLines", () => {
  it("reports no skill as one plain line", () => {
    expect(renderSkillLines({ skills: [], conflicts: [], droppedForLimit: 0 })).toEqual([]);
  });

  it("names the skill, the description, the scope, and the path", () => {
    const lines = renderSkillLines(resolveSkills([skill("routes")]));
    expect(lines[0]).toBe(
      "routes — the routes skill (repository skill, /w/primary/.agents/skills/routes/SKILL.md)",
    );
  });

  it("states a name conflict, the applied path, and every ignored path", () => {
    const set = resolveSkills([
      skill("routes"),
      {
        name: "routes",
        description: "the organization version",
        origin: origin({ scope: "organization", root: "/w/organization-skills", name: "routes",
          path: "/w/organization-skills/.agents/skills/routes/SKILL.md" }),
      },
    ]);
    const lines = renderSkillLines(set);
    expect(lines.some((line) => line.startsWith("Name conflict: \"routes\""))).toBe(true);
    expect(lines.some((line) => line.includes("/w/organization-skills/.agents/skills/routes/SKILL.md"))).toBe(true);
  });

  it("states a name conflict truthfully when the cap drops the conflicted name", () => {
    const filling = Array.from({ length: MAX_SKILLS }, (_value, index) =>
      skill(`skill-${String(index).padStart(3, "0")}`),
    );
    const droppedName = "skill-050";
    const set = resolveSkills([
      ...filling,
      skill(droppedName),
      skill(droppedName, { directory: ".claude/skills", path: `/w/primary/.claude/skills/${droppedName}/SKILL.md` }),
    ]);
    const lines = renderSkillLines(set);
    const conflictLine = lines.find((line) => line.startsWith(`Name conflict: "${droppedName}"`));
    expect(conflictLine).toBeDefined();
    expect(conflictLine).not.toContain("Factoree applies");
  });

  it("states the number of skills it dropped for the limit", () => {
    const many = Array.from({ length: MAX_SKILLS + 2 }, (_value, index) =>
      skill(`skill-${String(index).padStart(3, "0")}`),
    );
    const lines = renderSkillLines(resolveSkills(many));
    expect(lines.some((line) => line.includes("2 further skills"))).toBe(true);
  });
});
