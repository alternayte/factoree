import { describe, expect, it } from "vitest";
import { activatedPathsOf } from "~/activities/skill-registry.activities.js";

const skills = [
  { name: "lint", path: "/w/registry-skills/.agents/skills/lint/SKILL.md" },
  { name: "deploy", path: "/w/registry-skills/.agents/skills/deploy/SKILL.md" },
  { name: "routes", path: "/w/primary/.agents/skills/routes/SKILL.md" },
];

describe("activatedPathsOf (docs/specs/skill-registry.md)", () => {
  it("finds a SKILL.md read, a shell read of a skill file, and a native skill tool call", () => {
    const inputs = [
      JSON.stringify({ name: "read", input: { filePath: "/w/registry-skills/.agents/skills/lint/SKILL.md" } }),
      JSON.stringify({ name: "bash", input: { command: "cat /w/primary/.agents/skills/routes/references/api.md" } }),
      JSON.stringify({ name: "Skill", input: { skill: "deploy" } }),
    ];
    expect(activatedPathsOf(inputs, skills).sort()).toEqual(skills.map((skill) => skill.path).sort());
  });

  it("counts no skill that the session only listed", () => {
    const inputs = [JSON.stringify({ name: "bash", input: { command: "ls /w/registry-skills/.agents/skills" } })];
    expect(activatedPathsOf(inputs, skills)).toEqual([]);
  });
});
