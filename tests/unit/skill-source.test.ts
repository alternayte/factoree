import { describe, expect, it } from "vitest";
import { discoverSkills, MAX_SKILL_ENTRIES_PER_DIRECTORY } from "~/domain/runs/skill-source.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import type { SandboxRef } from "~/domain/runs/sandbox.js";

const ref: SandboxRef = { id: "s1", adapter: "fake", workspacePath: "/w" };

/** A sandbox whose `exec` answers `ls` and `cat` from two maps. */
const sandboxOf = (files: Record<string, string>, directories: Record<string, string[]>): FakeSandbox => {
  const sandbox = new FakeSandbox();
  sandbox.onExec = (command) => {
    const target = command.args.at(-1) ?? "";
    if (command.file === "ls") {
      const entries = directories[target];
      return entries === undefined
        ? { exitCode: 2, stdout: "", stderr: "no such directory" }
        : { exitCode: 0, stdout: `${entries.join("\n")}\n`, stderr: "" };
    }
    if (command.file === "cat") {
      const body = files[target];
      return body === undefined
        ? { exitCode: 1, stdout: "", stderr: "no such file" }
        : { exitCode: 0, stdout: body, stderr: "" };
    }
    return { exitCode: 127, stdout: "", stderr: `unexpected command ${command.file}` };
  };
  return sandbox;
};

describe("discoverSkills", () => {
  it("finds a skill under .agents/skills", async () => {
    const sandbox = sandboxOf(
      { "/w/primary/.agents/skills/routes/SKILL.md": "---\nname: routes\ndescription: Add a route.\n---\n" },
      { "/w/primary/.agents/skills": ["routes"] },
    );
    const set = await discoverSkills(sandbox, ref, [{ scope: "repository", path: "/w/primary" }]);
    expect(set.skills.map((entry) => entry.name)).toEqual(["routes"]);
    expect(set.skills[0]?.origin.directory).toBe(".agents/skills");
  });

  it("finds a skill under .claude/skills", async () => {
    const sandbox = sandboxOf(
      { "/w/primary/.claude/skills/tests/SKILL.md": "---\nname: tests\n---\n" },
      { "/w/primary/.claude/skills": ["tests"] },
    );
    const set = await discoverSkills(sandbox, ref, [{ scope: "repository", path: "/w/primary" }]);
    expect(set.skills.map((entry) => entry.name)).toEqual(["tests"]);
  });

  it("finds a skill under .codex/skills", async () => {
    const sandbox = sandboxOf(
      { "/w/primary/.codex/skills/deploy/SKILL.md": "---\nname: deploy\n---\n" },
      { "/w/primary/.codex/skills": ["deploy"] },
    );
    const set = await discoverSkills(sandbox, ref, [{ scope: "repository", path: "/w/primary" }]);
    expect(set.skills.map((entry) => entry.name)).toEqual(["deploy"]);
  });

  it("reports nothing when no skill directory exists", async () => {
    const set = await discoverSkills(sandboxOf({}, {}), ref, [{ scope: "repository", path: "/w/primary" }]);
    expect(set.skills).toEqual([]);
    expect(set.conflicts).toEqual([]);
  });

  it("skips a directory entry that holds no SKILL.md", async () => {
    const sandbox = sandboxOf(
      { "/w/primary/.agents/skills/real/SKILL.md": "---\nname: real\n---\n" },
      { "/w/primary/.agents/skills": ["real", "README.md", "empty"] },
    );
    const set = await discoverSkills(sandbox, ref, [{ scope: "repository", path: "/w/primary" }]);
    expect(set.skills.map((entry) => entry.name)).toEqual(["real"]);
  });

  it("refuses an entry name that could escape the skill directory", async () => {
    const sandbox = sandboxOf(
      { "/w/primary/.agents/skills/ok/SKILL.md": "---\nname: ok\n---\n" },
      { "/w/primary/.agents/skills": ["..", ".", "-rf", "a/b", "ok"] },
    );
    const set = await discoverSkills(sandbox, ref, [{ scope: "repository", path: "/w/primary" }]);
    expect(set.skills.map((entry) => entry.name)).toEqual(["ok"]);

    // The filter must stop the unusable entry BEFORE it reaches a command. A test that
    // checks only the result passes even when the filter is gone, because the read misses.
    const read = sandbox.commands.filter((command) => command.file === "cat").map((command) => command.args.at(-1));
    expect(read).toEqual(["/w/primary/.agents/skills/ok/SKILL.md"]);
  });

  it("applies the repository skill and shadows the organization skill of the same name", async () => {
    const sandbox = sandboxOf(
      {
        "/w/primary/.agents/skills/routes/SKILL.md": "---\nname: routes\ndescription: repo.\n---\n",
        "/w/organization-skills/.agents/skills/routes/SKILL.md": "---\nname: routes\ndescription: org.\n---\n",
      },
      {
        "/w/primary/.agents/skills": ["routes"],
        "/w/organization-skills/.agents/skills": ["routes"],
      },
    );
    const set = await discoverSkills(sandbox, ref, [
      { scope: "repository", path: "/w/primary" },
      { scope: "organization", path: "/w/organization-skills" },
    ]);
    expect(set.skills).toHaveLength(1);
    expect(set.skills[0]?.description).toBe("repo.");
    expect(set.conflicts).toHaveLength(1);
    expect(set.conflicts[0]?.shadowed[0]?.scope).toBe("organization");
  });

  it("prefers .agents over .claude over .codex inside one root", async () => {
    const sandbox = sandboxOf(
      {
        "/w/primary/.agents/skills/routes/SKILL.md": "---\nname: routes\ndescription: agents.\n---\n",
        "/w/primary/.claude/skills/routes/SKILL.md": "---\nname: routes\ndescription: claude.\n---\n",
        "/w/primary/.codex/skills/routes/SKILL.md": "---\nname: routes\ndescription: codex.\n---\n",
      },
      {
        "/w/primary/.agents/skills": ["routes"],
        "/w/primary/.claude/skills": ["routes"],
        "/w/primary/.codex/skills": ["routes"],
      },
    );
    const set = await discoverSkills(sandbox, ref, [{ scope: "repository", path: "/w/primary" }]);
    expect(set.skills[0]?.description).toBe("agents.");
    expect(set.conflicts[0]?.shadowed).toHaveLength(2);
  });

  it("reads at most the entry limit of one directory", async () => {
    const entries = Array.from({ length: MAX_SKILL_ENTRIES_PER_DIRECTORY + 10 }, (_v, i) => `s${i}`);
    const files: Record<string, string> = {};
    for (const entry of entries) {
      files[`/w/primary/.agents/skills/${entry}/SKILL.md`] = `---\nname: ${entry}\n---\n`;
    }
    const sandbox = sandboxOf(files, { "/w/primary/.agents/skills": entries });
    const set = await discoverSkills(sandbox, ref, [{ scope: "repository", path: "/w/primary" }]);
    expect(set.skills.length).toBeLessThanOrEqual(50);
    expect(set.droppedForLimit).toBeGreaterThan(0);
  });
});
