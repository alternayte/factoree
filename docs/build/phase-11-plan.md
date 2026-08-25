# Phase 11 — Second runner and skills implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `ClaudeCodeRunner` and skill discovery, so the same fixture workflow reaches verification with either required runner, and so a repository skill and an organization skill reach the Implementer with a recorded origin and no silent overwrite.

**Architecture:** A shared abstract base, `CliAgentRunner`, holds the process poll, the timeout, the cancel path, and the result build that `OpenCodeRunner` already proved. `OpenCodeRunner` and the new `ClaudeCodeRunner` supply only a start command, a resume command, and a parser. Skill discovery is two modules: a pure resolver in `src/domain/runs/skill-discovery.ts` that parses one `SKILL.md`, orders candidates, and reports every conflict, and a reader in `src/domain/runs/skill-source.ts` that lists and reads the files through `Sandbox.exec`. `SandboxManager` runs the reader after checkout and returns rendered skill lines. Those lines travel through the prepare activity, the workflow, and the implement activity into the Implementer prompt.

**Tech Stack:** TypeScript with ESM, Node 24, Temporal, Prisma with PostgreSQL, Vitest, Zod, the `yaml` package.

**Spec:** `docs/sdd.md` version 2.0, SHA-256 `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`. Read SDD sections 10, 14, 15, 16, 29, 32, 33, 34, 53, 56, 57, 61, 64 (AT-14, AT-15, AT-37), 67, and 69. The SDD is immutable and authoritative.

**Prior state:** `docs/build/STATUS.md`. Read the "Read this before Phase 11" block before Task 4.

## Global Constraints

- The SDD is immutable. Do not edit `docs/sdd.md`.
- Prose in code comments, commit messages, and Markdown follows ASD-STE100. Active voice. No contractions. No `-ing` forms outside a technical name. No `should`, `may`, `might`, `would`, `could`. 20 words maximum in a procedural sentence, 25 in a descriptive sentence.
- Node 24 is at `/opt/homebrew/opt/node@24/bin`. Prefix `PATH` with it in every shell.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`. Never write a file through a `cat` heredoc. Use `git commit -F <file>`.
- Run `npm run lint` and `npm run typecheck` over the whole repository at every task gate.
- Unit tests run with `npx vitest run <path>`. Integration and acceptance tests run with `npx vitest run --config vitest.integration.config.ts <path>`. Workflow tests run with `npx vitest run --config vitest.workflow.config.ts <path>`.
- Docker must run for the integration, acceptance, and workflow suites.
- The import alias is `~/` for `src/`. The workflow file itself must use relative paths for value imports, because the workflow bundler resolves no alias.
- SDD section 33: a Temporal workflow depends only on the `AgentRunner` interface. No workflow file names a concrete runner.
- SDD section 30: a prompt travels in the process environment, never on a command line. A process listing must never show it.
- SDD section 16: a skill name conflict must not silently overwrite another skill.
- SDD section 57: an applicable skill ranks ninth. It cannot override Factoree security policy, the Action Policy, a recorded human decision, the frozen Validation Contract, or a Work Item constraint.
- SDD section 61: no full agent transcript is persisted. A runner returns a redacted final message only.

---

## Controller decisions taken before this plan

Each decision closes a question the SDD leaves to the implementation. Record each one in `STATUS.md` at the end of the phase.

1. **The organization skills repository is a Project column, not a `.factoree/config.yaml` key.** SDD section 16 says a Project defines it. SDD section 57 ranks the repository file below the Project, so a repository must not be able to name its own organization skills source.
2. **The organization skills repository is checked out read-only into `${workspacePath}/organization-skills`.** It does not enter the `reference/` tree, so it can never collide with a reference repository name, and it never appears in `referencePaths`.
3. **The organization skills repository is checked out at the Project default branch.** SDD section 20 pins a SHA for the primary repository, because discovery resolves it. No discovery step resolves a skills repository, so the default branch is the only defined ref.
4. **A name conflict keeps every skill and applies exactly one.** The applied skill and every shadowed skill reach the prompt by name, path, and scope. Nothing is dropped, so nothing is overwritten silently.
5. **Precedence is repository before organization, then `.agents`, `.claude`, `.codex`, then the directory name in ascending order.** A repository states its own rules, so it wins over the organization. The rest is a fixed, auditable order rather than a race on directory listing order.
6. **The prompt carries the skill name, the description, and the origin. It does not carry the skill body.** The body can be tens of kilobytes and would push the goal out of the prompt. The origin names the path, so the agent can open the file itself.
7. **Skills reach the Implementer only.** SDD section 34 lists applicable skills in the Implementer input. SDD section 38 and section 40 do not list them for the User Validator or the Reviewer. Phase 11 does not widen either input.
8. **An unknown runner name fails the Run as a configuration fault, at preparation.** SDD section 14 requires configuration-driven runner selection. A name no adapter implements must fail where the operator sees `CONFIGURATION_INVALID`, not deep inside the implement activity.
9. **`CliAgentRunner` is an extraction, not a rewrite.** Every existing `OpenCodeRunner` test must pass unchanged. That is the proof that behaviour survived.
10. **The Claude Code prompt travels on standard input.** The runner starts `sh -c` and pipes the environment value into the CLI, so the prompt never reaches a command line.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/domain/runs/skill-discovery.ts` (create) | The pure skill types, the `SKILL.md` parse, the precedence order, the conflict report, and the prompt lines. No IO. |
| `src/domain/runs/skill-source.ts` (create) | Lists and reads skill files through `Sandbox.exec`. The only IO of skill discovery. |
| `src/adapters/runners/cli-agent-runner.ts` (create) | The shared command-line runner base. Poll, timeout, cancel, and result build. |
| `src/adapters/runners/opencode/opencode-runner.ts` (modify) | Becomes a `CliAgentRunner` subclass. Behaviour unchanged. |
| `src/adapters/runners/claude-code/claude-code-runner.ts` (create) | The Claude Code adapter of the `AgentRunner` port. |
| `src/adapters/runners/claude-code/output-parser.ts` (create) | Reads the Claude Code `stream-json` event stream. It never throws. |
| `prisma/schema.prisma` (modify) | Adds `Project.organizationSkillsRepository`. |
| `prisma/migrations/20260901120000_add_organization_skills/migration.sql` (create) | The migration for that column. |
| `src/domain/projects/project-registry.ts` (modify) | Adds the field to the record and to both inputs. |
| `src/persistence/prisma/project-registry.prisma.ts` (modify) | Reads and writes the new column. |
| `src/http/admin/projects.routes.ts` (modify) | Accepts and updates the new field. |
| `src/domain/runs/checkout.ts` (modify) | Adds `checkoutOrganizationSkills`. |
| `src/domain/runs/sandbox-manager.ts` (modify) | Checks out the skills repository, runs discovery, returns the skill lines. |
| `src/domain/runs/agent-runner.ts` (modify) | Adds `assertKnownRunners`. |
| `src/activities/sandbox.activities.ts` (modify) | Carries the skills repository in, and the skill lines out. Asserts the runner names. |
| `src/activities/agent.activities.ts` (modify) | Carries `skills` into `buildImplementerInput`. |
| `src/prompts/implementer.ts` (modify) | Renders the skill lines and the SDD section 57 precedence notice. Prompt version rises. |
| `src/workflows/agent-run.workflow.ts` (modify) | Carries the skills repository in and the skill lines through to the Implementer. |
| `src/domain/runs/delegation-service.ts` (modify) | Carries the Project field into the workflow input. |
| `src/bin/worker.ts` (modify) | Registers both required runners. |
| `tests/fixtures/bin/claude-stub.sh` (create) | A deterministic stand-in for the Claude Code CLI. |
| `tests/fixtures/bin/claude-liar-stub.sh` (create) | A Claude Code stand-in that claims success and changes nothing. |
| `tests/acceptance/support/runner-fixture.ts` (create) | The one fixture drive that AT-14 and AT-15 both run. |

---

### Task 1: The pure skill resolver

**Files:**
- Create: `src/domain/runs/skill-discovery.ts`
- Test: `tests/unit/skill-discovery.test.ts`

**Interfaces:**
- Consumes: the `yaml` package (`parse`).
- Produces: `SKILL_DIRECTORIES`, `SKILL_FILE_NAME`, `SkillScope`, `SkillOrigin`, `DiscoveredSkill`, `SkillConflict`, `SkillSet`, `parseSkillDocument(text: string, origin: SkillOrigin): DiscoveredSkill`, `resolveSkills(candidates: DiscoveredSkill[]): SkillSet`, `renderSkillLines(set: SkillSet): string[]`, `MAX_SKILLS = 50`, `MAX_DESCRIPTION_CHARACTERS = 300`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/skill-discovery.test.ts`:

```ts
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

  it("states the number of skills it dropped for the limit", () => {
    const many = Array.from({ length: MAX_SKILLS + 2 }, (_value, index) =>
      skill(`skill-${String(index).padStart(3, "0")}`),
    );
    const lines = renderSkillLines(resolveSkills(many));
    expect(lines.some((line) => line.includes("2 further skills"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/skill-discovery.test.ts`
Expected: FAIL, because `~/domain/runs/skill-discovery.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/domain/runs/skill-discovery.ts`:

```ts
import { parse as parseYaml } from "yaml";

/**
 * SDD section 16. Factoree reuses the common agent skill formats. The order is the precedence
 * order Factoree applies inside one scope. A repository skill always precedes an organization
 * skill, whatever directory holds it.
 */
export const SKILL_DIRECTORIES = [".agents/skills", ".claude/skills", ".codex/skills"] as const;

/** SDD section 16 fixes the file name of a skill. */
export const SKILL_FILE_NAME = "SKILL.md";

/** The largest number of skills that reaches one Implementer prompt. */
export const MAX_SKILLS = 50;

/** The largest description that reaches one prompt line. */
export const MAX_DESCRIPTION_CHARACTERS = 300;

export type SkillScope = "repository" | "organization";

/** SDD section 16 requires that skill origin is recorded. This type is that record. */
export interface SkillOrigin {
  scope: SkillScope;
  /** The checkout root that holds the skill. */
  root: string;
  /** One value of `SKILL_DIRECTORIES`. */
  directory: string;
  /** The directory name of the skill, below `directory`. */
  name: string;
  /** The absolute path of the `SKILL.md` inside the sandbox. */
  path: string;
}

export interface DiscoveredSkill {
  name: string;
  description: string;
  origin: SkillOrigin;
}

/** SDD section 16 forbids a silent overwrite. A conflict names every origin of one name. */
export interface SkillConflict {
  name: string;
  applied: SkillOrigin;
  shadowed: SkillOrigin[];
}

export interface SkillSet {
  skills: DiscoveredSkill[];
  conflicts: SkillConflict[];
  /** The number of distinct skill names that `MAX_SKILLS` removed. */
  droppedForLimit: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A usable skill name. It is one path-safe token, so it can never be read as a path. */
const USABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Collapses every run of whitespace, so one value can never break a prompt list. */
const singleLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const truncate = (text: string): string =>
  text.length <= MAX_DESCRIPTION_CHARACTERS ? text : `${text.slice(0, MAX_DESCRIPTION_CHARACTERS)}...`;

/** Reads the YAML frontmatter of a document. It returns null for every document without one. */
const frontmatterOf = (text: string): Record<string, unknown> | null => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (match === null) return null;
  const body = match[1];
  if (body === undefined) return null;
  try {
    const parsed: unknown = parseYaml(body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // A malformed frontmatter is not a Run fault. The directory name still names the skill.
    return null;
  }
};

/**
 * Builds one skill from one `SKILL.md`. A document that states nothing usable still becomes a
 * skill under its directory name, because the file exists and the agent can open it. The origin
 * travels unchanged, so SDD section 16 keeps its record of where the skill came from.
 */
export const parseSkillDocument = (text: string, origin: SkillOrigin): DiscoveredSkill => {
  const front = frontmatterOf(text);
  const declared = front?.["name"];
  const name =
    typeof declared === "string" && USABLE_NAME.test(declared.trim()) ? declared.trim() : origin.name;
  const description = front?.["description"];
  return {
    name,
    description: typeof description === "string" ? truncate(singleLine(description)) : "",
    origin,
  };
};

/**
 * Applies the precedence order of the candidate list and reports every conflict. The caller
 * supplies the candidates already ordered, so this function never re-orders them. It applies the
 * first candidate of each name and records every later candidate of that name as shadowed.
 *
 * SDD section 16 forbids a silent overwrite. A shadowed skill is therefore kept, named, and
 * reported. Nothing is discarded without a line that says so.
 */
export const resolveSkills = (candidates: DiscoveredSkill[]): SkillSet => {
  const applied = new Map<string, DiscoveredSkill>();
  const shadowed = new Map<string, SkillOrigin[]>();

  for (const candidate of candidates) {
    const existing = applied.get(candidate.name);
    if (existing === undefined) {
      applied.set(candidate.name, candidate);
      continue;
    }
    shadowed.set(candidate.name, [...(shadowed.get(candidate.name) ?? []), candidate.origin]);
  }

  const sorted = [...applied.values()].sort((left, right) => left.name.localeCompare(right.name));
  const kept = sorted.slice(0, MAX_SKILLS);
  const keptNames = new Set(kept.map((entry) => entry.name));

  const conflicts: SkillConflict[] = [];
  for (const entry of kept) {
    const others = shadowed.get(entry.name);
    if (others === undefined || others.length === 0) continue;
    conflicts.push({ name: entry.name, applied: entry.origin, shadowed: others });
  }

  return {
    skills: kept,
    conflicts,
    droppedForLimit: sorted.length - keptNames.size,
  };
};

const scopeWord = (scope: SkillScope): string =>
  scope === "repository" ? "repository skill" : "organization skill";

/**
 * Renders the prompt lines of one skill set. The body of a skill never appears here. A body can
 * reach tens of kilobytes and would push the goal out of the prompt. The path lets the agent open
 * the file itself.
 */
export const renderSkillLines = (set: SkillSet): string[] => {
  const lines = set.skills.map((entry) => {
    const detail = entry.description === "" ? "no description" : entry.description;
    return `${entry.name} — ${detail} (${scopeWord(entry.origin.scope)}, ${entry.origin.path})`;
  });

  for (const conflict of set.conflicts) {
    const ignored = conflict.shadowed.map((origin) => origin.path).join(", ");
    lines.push(
      `Name conflict: "${conflict.name}" exists in ${conflict.shadowed.length + 1} places. ` +
        `Factoree applies ${conflict.applied.path}. It ignores ${ignored}.`,
    );
  }

  if (set.droppedForLimit > 0) {
    lines.push(
      `Factoree found ${set.droppedForLimit} further skills and did not list them. ` +
        `The limit is ${MAX_SKILLS} skills.`,
    );
  }

  return lines;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/skill-discovery.test.ts`
Expected: PASS, every test.

- [ ] **Step 5: Run the repository gates**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint > /tmp/lint.txt 2>&1; echo "exit=$?"` then `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck > /tmp/tc.txt 2>&1; echo "exit=$?"`
Expected: `exit=0` for both. Never read the exit code through a pipe.

- [ ] **Step 6: Commit**

```bash
git add src/domain/runs/skill-discovery.ts tests/unit/skill-discovery.test.ts
git commit -F /tmp/commit-msg.txt
```

The message file holds: `feat(skills): add the pure skill resolver of SDD section 16`.

---

### Task 2: The sandbox skill reader

**Files:**
- Create: `src/domain/runs/skill-source.ts`
- Test: `tests/unit/skill-source.test.ts`
- Test: `tests/integration/skill-source-local.test.ts`

**Interfaces:**
- Consumes: `Sandbox` and `SandboxRef` from `~/domain/runs/sandbox.js`; every export of Task 1.
- Produces: `SkillRoot { scope: SkillScope; path: string }`, `discoverSkills(sandbox: Sandbox, ref: SandboxRef, roots: SkillRoot[]): Promise<SkillSet>`, `MAX_SKILL_ENTRIES_PER_DIRECTORY = 200`.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/skill-source.test.ts`. It uses the shared `FakeSandbox` and its `onExec` hook. Do not build a second fake sandbox.

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/skill-source.test.ts`
Expected: FAIL, because `~/domain/runs/skill-source.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/domain/runs/skill-source.ts`:

```ts
import type { Sandbox, SandboxRef } from "./sandbox.js";
import type { DiscoveredSkill, SkillScope, SkillSet } from "./skill-discovery.js";
import { parseSkillDocument, resolveSkills, SKILL_DIRECTORIES, SKILL_FILE_NAME } from "./skill-discovery.js";

/**
 * SDD section 16. The only honest source of a skill is the checkout inside the sandbox. Every
 * read goes through `Sandbox.exec`, so no adapter needs a file API and both adapters behave
 * alike. This mirrors `repository-config-source.ts`.
 */

/** The largest number of entries this reader opens in one skill directory. */
export const MAX_SKILL_ENTRIES_PER_DIRECTORY = 200;

export interface SkillRoot {
  scope: SkillScope;
  /** The absolute checkout path inside the sandbox. */
  path: string;
}

const join = (...parts: string[]): string =>
  parts.map((part, index) => (index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, ""))).join("/");

/**
 * A usable skill directory entry. A name with a slash, a leading hyphen, or a dot segment can
 * change the meaning of a command line or escape the directory. It is refused rather than read.
 */
const USABLE_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const listDirectory = async (sandbox: Sandbox, ref: SandboxRef, path: string): Promise<string[]> => {
  const result = await sandbox.exec(ref, { file: "ls", args: ["-1", "--", path] });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

const readFile = async (sandbox: Sandbox, ref: SandboxRef, path: string): Promise<string | null> => {
  const result = await sandbox.exec(ref, { file: "cat", args: ["--", path] });
  return result.exitCode === 0 ? result.stdout : null;
};

/**
 * Discovers every skill of every root, in precedence order. The caller supplies the roots in
 * that order, and the repository root always precedes the organization root. Inside one root the
 * order of `SKILL_DIRECTORIES` applies, and inside one directory the entry name orders the
 * candidates. `resolveSkills` then applies the first candidate of each name and reports the rest.
 */
export const discoverSkills = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  roots: SkillRoot[],
): Promise<SkillSet> => {
  const candidates: DiscoveredSkill[] = [];

  for (const root of roots) {
    for (const directory of SKILL_DIRECTORIES) {
      const base = join(root.path, directory);
      const entries = (await listDirectory(sandbox, ref, base))
        .filter((entry) => USABLE_ENTRY.test(entry))
        .sort((left, right) => left.localeCompare(right))
        .slice(0, MAX_SKILL_ENTRIES_PER_DIRECTORY);

      for (const entry of entries) {
        const path = join(base, entry, SKILL_FILE_NAME);
        const text = await readFile(sandbox, ref, path);
        // An entry without a SKILL.md is not a skill. A README file lives beside a skill.
        if (text === null) continue;
        candidates.push(
          parseSkillDocument(text, { scope: root.scope, root: root.path, directory, name: entry, path }),
        );
      }
    }
  }

  return resolveSkills(candidates);
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/skill-source.test.ts`
Expected: PASS, every test.

- [ ] **Step 5: Write the integration test against a real sandbox**

Create `tests/integration/skill-source-local.test.ts`:

```ts
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
    ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
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
```

- [ ] **Step 6: Run the integration test**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/skill-source-local.test.ts`
Expected: PASS, both tests.

- [ ] **Step 7: Run the repository gates**

Run lint and typecheck as in Task 1, Step 5. Expected: `exit=0` for both.

- [ ] **Step 8: Commit**

```bash
git add src/domain/runs/skill-source.ts tests/unit/skill-source.test.ts tests/integration/skill-source-local.test.ts
git commit -F /tmp/commit-msg.txt
```

The message file holds: `feat(skills): read skills from the sandbox checkout`.

---

### Task 3: The organization skills repository on the Project

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260901120000_add_organization_skills/migration.sql`
- Modify: `src/domain/projects/project-registry.ts`
- Modify: `src/persistence/prisma/project-registry.prisma.ts`
- Modify: `src/http/admin/projects.routes.ts`
- Test: `tests/integration/project-registry.test.ts`
- Test: `tests/integration/admin-api.test.ts`

**Interfaces:**
- Produces: `ProjectRecord.organizationSkillsRepository: string | null`, `CreateProjectInput.organizationSkillsRepository?: string | null`, and the same key on `UpdateProjectInput`.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/project-registry.test.ts`, inside the existing `describe`:

```ts
  it("stores and clears the organization skills repository of SDD section 16", async () => {
    const project = await registry.create({
      tenantId: tenant.id,
      key: "skills-project",
      name: "Skills project",
      primaryRepository: "acme/app",
      organizationSkillsRepository: "acme/skills",
    });
    expect(project.organizationSkillsRepository).toBe("acme/skills");

    const updated = await registry.update(tenant.id, project.id, { organizationSkillsRepository: null });
    expect(updated?.organizationSkillsRepository).toBeNull();
  });

  it("defaults the organization skills repository to null", async () => {
    const project = await registry.create({
      tenantId: tenant.id,
      key: "plain-project",
      name: "Plain project",
      primaryRepository: "acme/app",
    });
    expect(project.organizationSkillsRepository).toBeNull();
  });
```

Read the existing file first, and reuse its `registry` and `tenant` set-up exactly. Do not invent a new harness.

Add to `tests/integration/admin-api.test.ts`:

```ts
  it("accepts and returns the organization skills repository", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/projects",
      headers: authHeaders,
      payload: {
        linearWorkspaceId: "ws-skills",
        key: "skills",
        name: "Skills",
        primaryRepository: "acme/app",
        organizationSkillsRepository: "acme/skills",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().organizationSkillsRepository).toBe("acme/skills");
  });

  it("refuses an organization skills repository that is not an owner and repository slug", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/projects",
      headers: authHeaders,
      payload: {
        linearWorkspaceId: "ws-bad-skills",
        key: "bad-skills",
        name: "Bad skills",
        primaryRepository: "acme/app",
        organizationSkillsRepository: "not-a-slug",
      },
    });
    expect(created.statusCode).toBe(400);
  });
```

Read the existing file first and reuse its `app` and header set-up exactly.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/project-registry.test.ts tests/integration/admin-api.test.ts`
Expected: FAIL. The registry test fails on an unknown field. The API test fails, because the route drops the key.

- [ ] **Step 3: Add the column**

In `prisma/schema.prisma`, inside `model Project`, after `referenceRepositories`:

```prisma
  // SDD section 16. A Project can define one organization-wide skills repository. The value is
  // an owner and repository slug, the same shape `primaryRepository` uses.
  organizationSkillsRepository String?
```

Create `prisma/migrations/20260901120000_add_organization_skills/migration.sql`:

```sql
-- SDD section 16. One optional organization-wide skills repository for each Project.
ALTER TABLE "Project" ADD COLUMN "organizationSkillsRepository" TEXT;
```

Regenerate the client:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH DATABASE_URL="postgresql://u:p@localhost:5432/db" npx prisma generate
```

- [ ] **Step 4: Thread the field through the registry**

In `src/domain/projects/project-registry.ts`, add to `ProjectRecord`:

```ts
  /** SDD section 16. An owner and repository slug, or null. */
  organizationSkillsRepository: string | null;
```

Add to `CreateProjectInput`:

```ts
  organizationSkillsRepository?: string | null;
```

`UpdateProjectInput` derives from `CreateProjectInput`, so it needs no change.

In `src/persistence/prisma/project-registry.prisma.ts`, add `organizationSkillsRepository: string | null;` to `ProjectRow`, and add to both `create` and `update`:

```ts
        ...(input.organizationSkillsRepository === undefined
          ? {}
          : { organizationSkillsRepository: input.organizationSkillsRepository }),
```

- [ ] **Step 5: Accept the field in the admin route**

In `src/http/admin/projects.routes.ts`, add to `createSchema`:

```ts
  // SDD section 16. One organization-wide skills repository, as an owner and repository slug.
  organizationSkillsRepository: z.string().regex(/^[^/]+\/[^/]+$/).nullable().optional(),
```

Add to the `create` call and to the `update` object:

```ts
      ...(parsed.data.organizationSkillsRepository === undefined
        ? {}
        : { organizationSkillsRepository: parsed.data.organizationSkillsRepository }),
```

```ts
      ...(body.data.organizationSkillsRepository === undefined
        ? {}
        : { organizationSkillsRepository: body.data.organizationSkillsRepository }),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/project-registry.test.ts tests/integration/admin-api.test.ts`
Expected: PASS, every test.

- [ ] **Step 7: Run the repository gates**

Run lint and typecheck. Expected: `exit=0` for both.

- [ ] **Step 8: Commit**

```bash
git add prisma src/domain/projects/project-registry.ts src/persistence/prisma/project-registry.prisma.ts src/http/admin/projects.routes.ts tests/integration/project-registry.test.ts tests/integration/admin-api.test.ts
git commit -F /tmp/commit-msg.txt
```

The message file holds: `feat(skills): add the organization skills repository to the Project`.

---

### Task 4: Discover skills during sandbox preparation

**Files:**
- Modify: `src/domain/runs/checkout.ts`
- Modify: `src/domain/runs/sandbox-manager.ts`
- Modify: `src/activities/sandbox.activities.ts`
- Modify: `src/activities/agent.activities.ts`
- Modify: `src/prompts/implementer.ts`
- Modify: `src/domain/runs/implementer-input.ts`
- Modify: `src/domain/runs/delegation-service.ts`
- Modify: `src/workflows/agent-run.workflow.ts`
- Test: `tests/unit/checkout.test.ts`
- Test: `tests/unit/sandbox-manager.test.ts`
- Test: `tests/unit/prepare-sandbox-activity.test.ts`
- Test: `tests/unit/implementer-prompt.test.ts`
- Test: `tests/unit/implement-activity.test.ts`
- Test: `tests/unit/delegation-service.test.ts`

**Interfaces:**
- Consumes: `discoverSkills` and `SkillRoot` from Task 2; `renderSkillLines` from Task 1.
- Produces: `checkoutOrganizationSkills(sandbox, ref, spec): Promise<CheckedOutRepository>`; `PrepareSandboxInput.organizationSkills?: RepositorySpec`; `PreparedSandbox.skills: string[]`; `PrepareSandboxActivityInput.organizationSkills: RepositorySpec | null`; `PrepareSandboxActivityOutput.skills: string[]`; `ImplementActivityInput.skills: string[]`; `AgentRunProjectInput.organizationSkillsRepository: string | null`; `IMPLEMENTER_PROMPT_VERSION = "implementer/2"`.

- [ ] **Step 1: Write the failing checkout test**

Add to `tests/unit/checkout.test.ts`. Read the file first and reuse its fake sandbox exactly.

```ts
  it("checks out the organization skills repository read-only into its own directory", async () => {
    const sandbox = recordingSandbox();
    const checked = await checkoutOrganizationSkills(sandbox, ref, { url: "https://git/acme/skills.git", ref: "main" });
    expect(checked.path).toBe(`${ref.workspacePath}/organization-skills`);
    expect(checked.readOnly).toBe(true);
    expect(sandbox.commands.some((c) => c.file === "chmod" && c.args.includes(checked.path))).toBe(true);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/checkout.test.ts`
Expected: FAIL, because `checkoutOrganizationSkills` does not exist.

- [ ] **Step 3: Add the checkout**

In `src/domain/runs/checkout.ts`, after `checkoutReferences`:

```ts
/**
 * SDD section 16 and section 32. Checks out the organization skills repository and makes it
 * read-only. It lives in its own directory, not under `reference/`, so it can never collide with
 * a reference repository name, and it never appears in the reference path list of the prompt.
 */
export const checkoutOrganizationSkills = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  spec: RepositorySpec,
): Promise<CheckedOutRepository> => {
  const path = `${ref.workspacePath}/organization-skills`;
  const baseSha = await clone(sandbox, ref, spec, path);
  // SDD section 29 denies writing a repository the agent must only read. This is a file mode.
  await run(sandbox, ref, { file: "chmod", args: ["-R", "a-w", path] });
  return { url: spec.url, path, baseSha, readOnly: true };
};
```

- [ ] **Step 4: Run the checkout test to verify it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/checkout.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing sandbox manager test**

Add to `tests/unit/sandbox-manager.test.ts`. Read the file first and reuse its fake sandbox exactly. The fake must answer `ls` and `cat` for the skill paths.

```ts
  it("returns the discovered skill lines of the primary checkout", async () => {
    const sandbox = fakeSandboxWithSkills({
      "/work/primary/.agents/skills": ["routes"],
    }, {
      "/work/primary/.agents/skills/routes/SKILL.md": "---\nname: routes\ndescription: Add a route.\n---\n",
    });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const prepared = await manager.prepare(baseInput());
    expect(prepared.skills.some((line) => line.startsWith("routes — Add a route."))).toBe(true);
  });

  it("returns no skill line for a repository that defines none", async () => {
    const manager = new SandboxManager({ sandbox: fakeSandbox(), allowUnenforcedNetwork: true });
    const prepared = await manager.prepare(baseInput());
    expect(prepared.skills).toEqual([]);
  });

  it("checks out the organization skills repository when the Project names one", async () => {
    const sandbox = fakeSandbox();
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    await manager.prepare({ ...baseInput(), organizationSkills: { url: "https://git/acme/skills.git", ref: "main" } });
    expect(sandbox.commands.some((c) => c.args.includes("/work/organization-skills"))).toBe(true);
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/sandbox-manager.test.ts`
Expected: FAIL, because `PreparedSandbox` carries no `skills`.

- [ ] **Step 7: Discover skills in the manager**

In `src/domain/runs/sandbox-manager.ts`:

Add the import:

```ts
import { checkoutOrganizationSkills } from "./checkout.js";
import { discoverSkills } from "./skill-source.js";
import { renderSkillLines } from "./skill-discovery.js";
import type { SkillRoot } from "./skill-source.js";
```

Add to `PrepareSandboxInput`:

```ts
  /** SDD section 16. The organization-wide skills repository of the Project, when it has one. */
  organizationSkills?: RepositorySpec;
```

Add to `PreparedSandbox`:

```ts
  /**
   * SDD section 16 and section 34. The applicable skills of this Run, already rendered as prompt
   * lines. Each line names the skill, its description, its scope, and its path. A name conflict
   * carries its own line, so no skill is ever overwritten silently.
   */
  skills: string[];
```

Inside `prepare`, after `readRepositoryInstructions` and before the network policy is narrowed:

```ts
      // SDD section 16. The organization skills repository is read-only, and it lives outside
      // the `reference/` tree. It is checked out while the checkout hosts are still allowed.
      const organizationSkills =
        input.organizationSkills === undefined
          ? null
          : await checkoutOrganizationSkills(sandbox, ref, input.organizationSkills);
```

The checkout host list must therefore include the skills repository host. Change the `checkoutHosts` call to pass the skills spec too:

```ts
  const specs = [input.primary, ...input.references];
  if (input.organizationSkills !== undefined) specs.push(input.organizationSkills);
```

Then, after the network policy is narrowed:

```ts
      // SDD section 16. Discovery runs on the checkouts, in precedence order. A repository skill
      // always precedes an organization skill of the same name.
      const roots: SkillRoot[] = [{ scope: "repository", path: primary.path }];
      if (organizationSkills !== null) roots.push({ scope: "organization", path: organizationSkills.path });
      const skills = renderSkillLines(await discoverSkills(sandbox, ref, roots));
```

Return `skills` from `prepare`.

Read the existing `prepare` body before editing. Keep the existing order of the three network policies unchanged, apart from the wider first host list.

- [ ] **Step 8: Run the manager test to verify it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/sandbox-manager.test.ts`
Expected: PASS.

- [ ] **Step 9: Carry the skills through the prepare activity**

In `src/activities/sandbox.activities.ts`, add to `PrepareSandboxActivityInput`:

```ts
  /** SDD section 16. The organization skills repository of the Project, or null. */
  organizationSkills: RepositorySpec | null;
```

Add to `PrepareSandboxActivityOutput`:

```ts
  /** SDD sections 16 and 34. The applicable skills, as prompt lines. */
  skills: string[];
```

In `prepare`, pass the value through and return it:

```ts
    ...(input.organizationSkills === null ? {} : { organizationSkills: input.organizationSkills }),
```

```ts
    skills: prepared.skills,
```

Add to `tests/unit/prepare-sandbox-activity.test.ts` a test that the activity returns the skill lines the manager produced, and add `organizationSkills: null` to every existing input in that file.

- [ ] **Step 10: Render the skills in the Implementer prompt**

In `src/prompts/implementer.ts`, change the version and the section:

```ts
/** SDD section 56 requires prompt versioning. Change this value whenever the template below changes. */
export const IMPLEMENTER_PROMPT_VERSION = "implementer/2";
```

```ts
    section(
      "Applicable skills",
      `${list(fields.skills, "None supplied.")}\n\n` +
        "SDD section 57 ranks a skill ninth. A skill cannot override Factoree security policy, " +
        "the Action Policy, a recorded human decision, the frozen Validation Contract, or a " +
        "Work Item constraint. A line that reports a name conflict names the file Factoree " +
        "applies. Ignore every file that line reports as ignored.",
    ),
```

Add to `tests/unit/implementer-prompt.test.ts`:

```ts
  it("states the SDD section 57 precedence of a skill", () => {
    const prompt = renderImplementerPrompt({ ...fields, skills: ["routes — Add a route. (repository skill, /w/x)"] });
    expect(prompt).toContain("routes — Add a route.");
    expect(prompt).toContain("SDD section 57 ranks a skill ninth");
  });

  it("reports the prompt version 2", () => {
    expect(IMPLEMENTER_PROMPT_VERSION).toBe("implementer/2");
  });
```

- [ ] **Step 11: Carry the skills into the implement activity**

In `src/activities/agent.activities.ts`, add to `ImplementActivityInput`:

```ts
  /** SDD sections 16 and 34. The applicable skills, as prompt lines. */
  skills: string[];
```

Change the `buildImplementerInput` call from `skills: []` to `skills: input.skills`.

Add to `tests/unit/implement-activity.test.ts` a test that a skill line reaches the prompt the runner receives, and add `skills: []` to every existing input in that file.

- [ ] **Step 12: Carry the Project field into the workflow**

In `src/workflows/agent-run.workflow.ts`, add to `AgentRunProjectInput`:

```ts
  /** SDD section 16. The organization skills repository slug of the Project, or null. */
  organizationSkillsRepository: string | null;
```

In the sandbox block, add:

```ts
        organizationSkills:
          input.project.organizationSkillsRepository === null
            ? null
            : {
                url: buildRepositoryUrl(input.project.repositoryBaseUrl, input.project.organizationSkillsRepository),
                // No discovery step resolves a skills repository, so the Project default branch
                // is the only defined ref. See controller decision 3.
                ref: input.project.defaultBranch,
              },
```

Pass `organizationSkills: sandbox.organizationSkills` to `prepareSandbox`.

In `runImplementer`, add to the `implement` call:

```ts
        skills: attemptInput.prepared.skills,
```

In `src/domain/runs/delegation-service.ts`, add to `workflowProject`:

```ts
      organizationSkillsRepository: project.organizationSkillsRepository,
```

Add an assertion for the slug beside the existing ones:

```ts
        if (project.organizationSkillsRepository !== null) {
          assertRepositorySlug(project.organizationSkillsRepository);
        }
```

Add to `tests/unit/delegation-service.test.ts` a test that the workflow input carries the value, and a test that an unusable skills slug reports `unconfigured`.

- [ ] **Step 13: Repair every other caller**

Run the whole unit and workflow suites. Every fake project record, every `prepareSandbox` input, and every `implement` input needs the new keys. Add `organizationSkillsRepository: null`, `organizationSkills: null`, `skills: []` where the type demands them.

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run > /tmp/unit.txt 2>&1; echo "exit=$?"`
Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.workflow.config.ts > /tmp/wf.txt 2>&1; echo "exit=$?"`
Expected: `exit=0` for both.

- [ ] **Step 14: Run the repository gates**

Run lint and typecheck. Expected: `exit=0` for both.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -F /tmp/commit-msg.txt
```

The message file holds: `feat(skills): deliver discovered skills to the Implementer prompt`.

---

### Task 5: The shared command-line runner base

**Files:**
- Create: `src/adapters/runners/cli-agent-runner.ts`
- Modify: `src/adapters/runners/opencode/opencode-runner.ts`

**Interfaces:**
- Consumes: `AgentRunner`, `AgentRunInput`, `AgentResumeInput`, `AgentRunResult`, `AgentSessionRef` from `~/domain/runs/agent-runner.js`; `ProcessRef`, `ProcessSnapshot`, `Sandbox`, `SandboxRef` from `~/domain/runs/sandbox.js`; `Redactor` from `~/telemetry/redaction.js`.
- Produces: `CliAgentCommand { file: string; args: string[]; env: Record<string, string> }`, `CliAgentParse { sessionId: string | null; summary: string }`, `CliAgentRunnerOptions { redactor: Redactor; pollIntervalMs?: number; clock?: () => number }`, `abstract class CliAgentRunner implements AgentRunner`.

**This task changes no behaviour.** Every existing `OpenCodeRunner` test must pass unchanged. That is the proof.

- [ ] **Step 1: Run the existing runner tests and record the green baseline**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/opencode-runner.test.ts tests/unit/opencode-output-parser.test.ts > /tmp/base.txt 2>&1; echo "exit=$?"`
Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/opencode-runner-local.test.ts >> /tmp/base.txt 2>&1; echo "exit=$?"`
Expected: `exit=0` for both. Keep `/tmp/base.txt`. Do not edit a single line of those test files in this task.

- [ ] **Step 2: Write the base class**

Create `src/adapters/runners/cli-agent-runner.ts`. Move the body of `OpenCodeRunner` into it verbatim, and replace the three command-line and parse decisions with abstract members:

```ts
import type {
  AgentResumeInput,
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  AgentSessionRef,
} from "~/domain/runs/agent-runner.js";
import type { ProcessRef, ProcessSnapshot, Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import type { Redactor } from "~/telemetry/redaction.js";

/** One command line a runner starts inside the sandbox. */
export interface CliAgentCommand {
  file: string;
  args: string[];
  /** The values this command adds to the process environment. The prompt travels here. */
  env: Record<string, string>;
}

export interface CliAgentParse {
  sessionId: string | null;
  summary: string;
}

export interface CliAgentRunnerOptions {
  redactor: Redactor;
  pollIntervalMs?: number;
  clock?: () => number;
}

interface LiveSession {
  sandbox: Sandbox;
  ref: SandboxRef;
  process: ProcessRef;
  workingDirectory: string;
  environment: Record<string, string>;
  cancelled: boolean;
}

/**
 * The shared body of every command-line agent runner. SDD section 33 names two required
 * adapters, and both drive a command-line tool inside a sandbox. The poll loop, the budget, the
 * cancel path, and the result build are therefore one implementation. A subclass supplies only
 * the start command, the resume command, and the parser.
 *
 * The prompt travels in the process environment, never on the command line, so it never reaches
 * a process listing. A runner never receives a Linear token or a GitHub write credential. The
 * Implementer input assembler rejects those before a runner is called. See SDD section 30.
 */
export abstract class CliAgentRunner implements AgentRunner {
  abstract readonly name: string;
  private readonly pollIntervalMs: number;
  private readonly clock: () => number;
  // An entry lives for the lifetime of this runner instance. Factoree runs run and resume
  // as Temporal activities, and Temporal retries an activity with its original arguments
  // unchanged, so a caller can present an old AgentSessionRef on a retry. An entry must not
  // be removed while any caller can still hold a reference to it. Disposal of run-scoped
  // state belongs to a later phase that knows when a Run has ended. A worker restart clears
  // this map, and each entry is small, so the bounded growth is acceptable for now.
  private readonly sessions = new Map<string, LiveSession>();
  private readonly activeByRun = new Map<string, string>();

  constructor(protected readonly cliOptions: CliAgentRunnerOptions) {
    this.pollIntervalMs = cliOptions.pollIntervalMs ?? 1_000;
    this.clock = cliOptions.clock ?? Date.now;
  }

  /** The command that starts a new session with the given prompt. */
  protected abstract startCommand(prompt: string): CliAgentCommand;

  /** The command that continues an existing session with a further prompt. */
  protected abstract resumeCommand(sessionId: string, prompt: string): CliAgentCommand;

  /** Reads the output of the tool. An implementation must never throw. */
  protected abstract parseOutput(text: string): CliAgentParse;

  /**
   * Returns the session reference for a run that is still active, as soon as the sandbox
   * process starts. A caller uses this to cancel a run before it resolves, without a private
   * cast into runner state. It returns undefined once the run has no live process for the
   * given run identifier.
   *
   * A resumed run has no equivalent lookup, because `AgentResumeInput` carries no run
   * identifier. A caller that resumes a session already holds the `AgentSessionRef` it needs
   * to cancel that resumed run directly.
   */
  activeSession(runId: string): AgentSessionRef | undefined {
    const processId = this.activeByRun.get(runId);
    if (processId === undefined) return undefined;
    const live = this.sessions.get(processId);
    if (live === undefined) return undefined;
    return { sessionId: live.process.id, processId: live.process.id, runner: this.name };
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const command = this.startCommand(input.prompt);
    const process = await input.sandbox.startProcess(input.ref, {
      file: command.file,
      args: command.args,
      cwd: input.workingDirectory,
      env: { ...input.environment, ...command.env },
    });

    const live: LiveSession = {
      sandbox: input.sandbox,
      ref: input.ref,
      process,
      workingDirectory: input.workingDirectory,
      environment: input.environment,
      cancelled: false,
    };
    this.sessions.set(process.id, live);
    this.activeByRun.set(input.runId, process.id);

    try {
      return await this.awaitProcess(live, input.timeoutMs);
    } finally {
      if (this.activeByRun.get(input.runId) === process.id) this.activeByRun.delete(input.runId);
    }
  }

  async resume(session: AgentSessionRef, input: AgentResumeInput): Promise<AgentRunResult> {
    const previous = this.sessions.get(session.processId);
    if (previous === undefined) {
      throw new Error(`${this.name} has no live sandbox for session ${session.sessionId}.`);
    }

    const command = this.resumeCommand(session.sessionId, input.prompt);
    const process = await previous.sandbox.startProcess(previous.ref, {
      file: command.file,
      args: command.args,
      cwd: previous.workingDirectory,
      env: { ...previous.environment, ...command.env },
    });

    const live: LiveSession = { ...previous, process, cancelled: false };
    this.sessions.set(process.id, live);
    return await this.awaitProcess(live, input.timeoutMs);
  }

  async cancel(session: AgentSessionRef): Promise<void> {
    const live = this.sessions.get(session.processId);
    if (live === undefined) return;
    live.cancelled = true;
    await live.sandbox.cancelProcess(live.ref, live.process);
  }

  /** Polls the sandbox process until it exits, its budget ends, or Factoree cancels it. */
  private async awaitProcess(live: LiveSession, timeoutMs: number): Promise<AgentRunResult> {
    const startedAt = this.clock();
    const deadline = startedAt + timeoutMs;

    for (;;) {
      const snapshot = await live.sandbox.readProcess(live.ref, live.process);

      if (!snapshot.running) {
        return this.buildResult(live, snapshot, startedAt, {
          cancelled: live.cancelled,
          fallbackExitCode: 1,
        });
      }

      if (this.clock() >= deadline) {
        // On timeout Factoree cancels the active process and preserves the evidence it already
        // produced. See SDD section 50.
        await live.sandbox.cancelProcess(live.ref, live.process);
        const final = await live.sandbox.readProcess(live.ref, live.process);
        return this.buildResult(live, final, startedAt, {
          cancelled: true,
          completed: false,
          fallbackExitCode: 124,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  /**
   * Builds the final result from one process snapshot. It reads the output through a guarded
   * parse, so a malformed event never rejects the Run and never discards the evidence the agent
   * already produced. `completed`, when given, wins over the exit code check. This carries the
   * timeout branch, where the exit code alone does not say whether the Run finished its work.
   */
  private buildResult(
    live: LiveSession,
    snapshot: ProcessSnapshot,
    startedAt: number,
    options: { cancelled: boolean; completed?: boolean; fallbackExitCode: number },
  ): AgentRunResult {
    const parsed = this.safeParse(`${snapshot.stdout}\n${snapshot.stderr}`);
    const exitCode = snapshot.exitCode ?? options.fallbackExitCode;
    const completed = options.completed ?? (exitCode === 0 && !options.cancelled);
    return {
      session: {
        sessionId: parsed.sessionId ?? live.process.id,
        processId: live.process.id,
        runner: this.name,
      },
      completed,
      exitCode,
      summary: this.cliOptions.redactor.redact(parsed.summary),
      durationMs: this.clock() - startedAt,
      cancelled: options.cancelled,
    };
  }

  /**
   * Parses the process output and never throws. A parser fault must not reject the Run and
   * discard the evidence the agent already produced. This is a second, independent guard beyond
   * the parser's own defenses against a malformed line.
   */
  private safeParse(text: string): CliAgentParse {
    try {
      return this.parseOutput(text);
    } catch {
      return { sessionId: null, summary: "" };
    }
  }
}
```

- [ ] **Step 3: Reduce `OpenCodeRunner` to the base class**

Replace the whole body of `src/adapters/runners/opencode/opencode-runner.ts` with:

```ts
import type { CliAgentCommand, CliAgentParse, CliAgentRunnerOptions } from "../cli-agent-runner.js";
import { CliAgentRunner } from "../cli-agent-runner.js";
import { parseOpenCodeOutput } from "./output-parser.js";

export interface OpenCodeRunnerOptions extends CliAgentRunnerOptions {
  /** The executable inside the sandbox. Bootstrap installs it. */
  executable?: string;
}

/**
 * SDD section 33 names OpenCodeRunner as a required adapter of the AgentRunner port. It drives
 * the opencode command line tool inside a sandbox. `CliAgentRunner` holds every behaviour the
 * two required runners share.
 */
export class OpenCodeRunner extends CliAgentRunner {
  readonly name = "opencode";
  private readonly executable: string;

  constructor(options: OpenCodeRunnerOptions) {
    super(options);
    this.executable = options.executable ?? "opencode";
  }

  protected startCommand(prompt: string): CliAgentCommand {
    return {
      file: this.executable,
      args: ["run", "--print-logs", "--format", "json"],
      env: { FACTOREE_PROMPT: prompt },
    };
  }

  protected resumeCommand(sessionId: string, prompt: string): CliAgentCommand {
    return {
      file: this.executable,
      args: ["run", "--print-logs", "--format", "json", "--session", sessionId],
      env: { FACTOREE_PROMPT: prompt },
    };
  }

  protected parseOutput(text: string): CliAgentParse {
    return parseOpenCodeOutput(text);
  }
}
```

- [ ] **Step 4: Run the same tests and compare to the baseline**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/opencode-runner.test.ts tests/unit/opencode-output-parser.test.ts > /tmp/after.txt 2>&1; echo "exit=$?"`
Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/opencode-runner-local.test.ts >> /tmp/after.txt 2>&1; echo "exit=$?"`
Expected: `exit=0` for both, with the same number of passing tests as `/tmp/base.txt`. No test file changed.

- [ ] **Step 5: Run the repository gates**

Run lint and typecheck. Expected: `exit=0` for both.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/runners
git commit -F /tmp/commit-msg.txt
```

The message file holds: `refactor(runners): extract the shared command-line runner base`.

---

### Task 6: The Claude Code runner

**Files:**
- Create: `src/adapters/runners/claude-code/output-parser.ts`
- Create: `src/adapters/runners/claude-code/claude-code-runner.ts`
- Create: `tests/fixtures/bin/claude-stub.sh`
- Test: `tests/unit/claude-output-parser.test.ts`
- Test: `tests/unit/claude-code-runner.test.ts`
- Test: `tests/integration/claude-code-runner-local.test.ts`

**Interfaces:**
- Consumes: `CliAgentRunner`, `CliAgentCommand`, `CliAgentParse`, `CliAgentRunnerOptions` from Task 5.
- Produces: `parseClaudeOutput(text: string): { sessionId: string | null; summary: string }`, `ClaudeCodeRunner` with `readonly name = "claude"`, `ClaudeCodeRunnerOptions extends CliAgentRunnerOptions { executable?: string }`.

- [ ] **Step 1: Write the failing parser test**

Create `tests/unit/claude-output-parser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseClaudeOutput } from "~/adapters/runners/claude-code/output-parser.js";

describe("parseClaudeOutput", () => {
  it("reads the session identifier of the first event that carries one", () => {
    const text = [
      '{"type":"system","subtype":"init","session_id":"ses-abc"}',
      '{"type":"result","subtype":"success","session_id":"ses-def","result":"done"}',
    ].join("\n");
    expect(parseClaudeOutput(text).sessionId).toBe("ses-abc");
  });

  it("reads the summary from the result event", () => {
    const text = '{"type":"result","subtype":"success","session_id":"s","result":"The change is applied."}';
    expect(parseClaudeOutput(text).summary).toBe("The change is applied.");
  });

  it("reads the last assistant text when no result event arrived", () => {
    const text = [
      '{"type":"assistant","session_id":"s","message":{"content":[{"type":"text","text":"first"}]}}',
      '{"type":"assistant","session_id":"s","message":{"content":[{"type":"text","text":"second"}]}}',
    ].join("\n");
    expect(parseClaudeOutput(text).summary).toBe("second");
  });

  it("joins every text block of one assistant message", () => {
    const text =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"a"},{"type":"tool_use"},{"type":"text","text":"b"}]}}';
    expect(parseClaudeOutput(text).summary).toBe("a\nb");
  });

  it("prefers the result event over an earlier assistant message", () => {
    const text = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"}]}}',
      '{"type":"result","subtype":"success","result":"final"}',
    ].join("\n");
    expect(parseClaudeOutput(text).summary).toBe("final");
  });

  it("reads the result of an error event, because the text is still evidence", () => {
    const text = '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"it broke"}';
    expect(parseClaudeOutput(text).summary).toBe("it broke");
  });

  it("skips a line that is not JSON and keeps it as the last resort summary", () => {
    expect(parseClaudeOutput("a plain progress line\n").summary).toBe("a plain progress line");
  });

  it("skips a JSON value that is not an object", () => {
    expect(parseClaudeOutput("null\n42\n[1,2]\n\"text\"\n").sessionId).toBeNull();
  });

  it("reports nothing for empty output", () => {
    expect(parseClaudeOutput("")).toEqual({ sessionId: null, summary: "" });
  });

  it("never throws on malformed input", () => {
    expect(() => parseClaudeOutput('{"type":"result","result":{"nested":true}}')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/claude-output-parser.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Write the parser**

Create `src/adapters/runners/claude-code/output-parser.ts`:

```ts
export interface ClaudeOutput {
  sessionId: string | null;
  summary: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Joins every text block of one assistant message. A tool use block carries no text. */
const assistantText = (message: unknown): string | null => {
  if (!isRecord(message)) return null;
  const content = message["content"];
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block["type"] !== "text") continue;
    const text = block["text"];
    if (typeof text === "string" && text.length > 0) parts.push(text);
  }
  return parts.length === 0 ? null : parts.join("\n");
};

/**
 * Reads the newline-delimited JSON event stream of `claude -p --output-format stream-json`. The
 * CLI also writes plain progress lines. The parser skips a line that is not a JSON object
 * instead of failing the Run. A line that parses to a JSON value that is not an object, for
 * example `null`, a number, a string, or an array, is treated the same way, because none of
 * those shapes carries an event.
 *
 * The `result` event carries the final message, and it wins over every assistant message. An
 * error result still carries its text, because that text is evidence. SDD section P-01 states
 * that the claim of the agent never decides the outcome, so this parser never reads a success
 * flag as a verdict.
 */
export const parseClaudeOutput = (text: string): ClaudeOutput => {
  let sessionId: string | null = null;
  let resultSummary: string | null = null;
  let lastAssistant: string | null = null;
  let lastPlainLine = "";

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      lastPlainLine = trimmed;
      continue;
    }
    if (!isRecord(parsed)) {
      lastPlainLine = trimmed;
      continue;
    }

    const id = parsed["session_id"];
    if (sessionId === null && typeof id === "string" && id.length > 0) sessionId = id;

    if (parsed["type"] === "result") {
      const value = parsed["result"];
      if (typeof value === "string") resultSummary = value;
      continue;
    }

    if (parsed["type"] === "assistant") {
      const value = assistantText(parsed["message"]);
      if (value !== null) lastAssistant = value;
    }
  }

  const summary = resultSummary ?? lastAssistant ?? lastPlainLine;
  return { sessionId, summary };
};
```

- [ ] **Step 4: Run the parser test to verify it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/claude-output-parser.test.ts`
Expected: PASS, every test.

- [ ] **Step 5: Write the failing runner test**

Create `tests/unit/claude-code-runner.test.ts`. Read `tests/unit/opencode-runner.test.ts` first. It uses the shared `FakeSandbox` from `tests/support/fake-sandbox.ts`, its `runInput` helper, its `waitUntil` helper, and `sandbox.finishProcess(id, snapshot)` to end a process. Mirror that shape exactly. `FakeSandbox.commands` records every started command, including its `env`. Do not build a second fake sandbox, and do not change the original file.

The test bodies below name `fakeSandbox` and `runInput` for brevity. Replace both with the real `FakeSandbox` and `runInput` pattern of the OpenCode test file, and drive each process to its end with `finishProcess`.

```ts
import { describe, expect, it } from "vitest";
import { ClaudeCodeRunner } from "~/adapters/runners/claude-code/claude-code-runner.js";
import { Redactor } from "~/telemetry/redaction.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

describe("ClaudeCodeRunner", () => {
  it("is named claude, the name the stock configuration selects", () => {
    expect(new ClaudeCodeRunner({ redactor: new Redactor() }).name).toBe("claude");
  });

  it("never places the prompt on the command line", async () => {
    const sandbox = fakeSandbox({ stdout: '{"type":"result","result":"ok","session_id":"s"}', exitCode: 0 });
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    await runner.run(runInput(sandbox, "a secret goal sentence"));
    const started = sandbox.started[0];
    expect(started?.args.join(" ")).not.toContain("a secret goal sentence");
    expect(started?.env?.["FACTOREE_PROMPT"]).toBe("a secret goal sentence");
  });

  it("starts the CLI in non-interactive mode with the stream-json format", async () => {
    const sandbox = fakeSandbox({ stdout: '{"type":"result","result":"ok"}', exitCode: 0 });
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    await runner.run(runInput(sandbox, "goal"));
    const script = sandbox.started[0]?.args[1] ?? "";
    expect(sandbox.started[0]?.file).toBe("sh");
    expect(script).toContain("--print");
    expect(script).toContain("--output-format stream-json");
    expect(script).toContain("$FACTOREE_PROMPT");
  });

  it("resumes the named session and keeps the identifier out of the command line", async () => {
    const sandbox = fakeSandbox({ stdout: '{"type":"result","result":"ok","session_id":"ses-1"}', exitCode: 0 });
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const first = await runner.run(runInput(sandbox, "goal"));
    await runner.resume(first.session, { prompt: "repair it", timeoutMs: 1_000 });
    const resumed = sandbox.started[1];
    expect(resumed?.env?.["FACTOREE_CLAUDE_SESSION"]).toBe("ses-1");
    expect(resumed?.args.join(" ")).not.toContain("ses-1");
    expect(resumed?.args[1] ?? "").toContain("--resume");
  });

  it("reports a non-zero exit as an incomplete run", async () => {
    const sandbox = fakeSandbox({ stdout: '{"type":"result","result":"it broke"}', exitCode: 2 });
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const result = await runner.run(runInput(sandbox, "goal"));
    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it("redacts a Project secret the agent printed", async () => {
    const sandbox = fakeSandbox({ stdout: '{"type":"result","result":"I printed s3cr3t-value"}', exitCode: 0 });
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(["s3cr3t-value"]), pollIntervalMs: 1 });
    const result = await runner.run(runInput(sandbox, "goal"));
    expect(result.summary).not.toContain("s3cr3t-value");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/claude-code-runner.test.ts`
Expected: FAIL, because the runner does not exist.

- [ ] **Step 7: Write the runner**

Create `src/adapters/runners/claude-code/claude-code-runner.ts`:

```ts
import type { CliAgentCommand, CliAgentParse, CliAgentRunnerOptions } from "../cli-agent-runner.js";
import { CliAgentRunner } from "../cli-agent-runner.js";
import { parseClaudeOutput } from "./output-parser.js";

export interface ClaudeCodeRunnerOptions extends CliAgentRunnerOptions {
  /** The executable inside the sandbox. Bootstrap installs it. */
  executable?: string;
}

/**
 * The shell script that starts one non-interactive Claude Code session. The prompt reaches the
 * CLI on standard input, so it never appears on a command line and never reaches a process
 * listing. See SDD section 30 and controller decision 10.
 */
const START_SCRIPT =
  'printf %s "$FACTOREE_PROMPT" | "$FACTOREE_CLAUDE_BIN" --print --output-format stream-json --verbose';

/** The same script, continuing the session the environment names. */
const RESUME_SCRIPT =
  'printf %s "$FACTOREE_PROMPT" | "$FACTOREE_CLAUDE_BIN" --print --output-format stream-json --verbose ' +
  '--resume "$FACTOREE_CLAUDE_SESSION"';

/**
 * SDD section 33 names ClaudeCodeRunner as the second required adapter of the AgentRunner port.
 * It drives the `claude` command line tool inside a sandbox. `CliAgentRunner` holds the poll
 * loop, the budget, the cancel path, and the result build, so this class states only what is
 * specific to Claude Code.
 *
 * The name is `claude`, because SDD section 15 sets that name as the stock validator and
 * reviewer of `.factoree/config.yaml`.
 */
export class ClaudeCodeRunner extends CliAgentRunner {
  readonly name = "claude";
  private readonly executable: string;

  constructor(options: ClaudeCodeRunnerOptions) {
    super(options);
    this.executable = options.executable ?? "claude";
  }

  protected startCommand(prompt: string): CliAgentCommand {
    return {
      file: "sh",
      args: ["-c", START_SCRIPT],
      env: { FACTOREE_PROMPT: prompt, FACTOREE_CLAUDE_BIN: this.executable },
    };
  }

  protected resumeCommand(sessionId: string, prompt: string): CliAgentCommand {
    return {
      file: "sh",
      args: ["-c", RESUME_SCRIPT],
      env: {
        FACTOREE_PROMPT: prompt,
        FACTOREE_CLAUDE_BIN: this.executable,
        FACTOREE_CLAUDE_SESSION: sessionId,
      },
    };
  }

  protected parseOutput(text: string): CliAgentParse {
    return parseClaudeOutput(text);
  }
}
```

- [ ] **Step 8: Run the runner test to verify it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/claude-code-runner.test.ts`
Expected: PASS, every test.

- [ ] **Step 9: Write the stub and the integration test**

Create `tests/fixtures/bin/claude-stub.sh` and make it executable with `chmod +x`:

```sh
#!/bin/sh
# tests/fixtures/bin/claude-stub.sh
# A deterministic stand-in for the Claude Code CLI. It proves the runner contract without a model.
# It reads the prompt from standard input and writes the stream-json event stream the CLI writes.
set -e
PROMPT=$(/bin/cat)
printf '{"type":"system","subtype":"init","session_id":"ses_claude_1"}\n'
if [ -n "${FACTOREE_STUB_SLEEP:-}" ]; then
  sleep "$FACTOREE_STUB_SLEEP"
fi
if [ -n "${FACTOREE_STUB_TARGET:-}" ]; then
  printf '%s\n' "$PROMPT" > "$FACTOREE_STUB_TARGET"
fi
if [ -n "${FACTOREE_STUB_PRINT_SECRET:-}" ]; then
  printf '{"type":"result","subtype":"success","session_id":"ses_claude_1","result":"I printed %s"}\n' \
    "$FACTOREE_STUB_PRINT_SECRET"
else
  printf '{"type":"result","subtype":"success","session_id":"ses_claude_1","result":"The change is applied."}\n'
fi
exit "${FACTOREE_STUB_EXIT:-0}"
```

Create `tests/integration/claude-code-runner-local.test.ts` as an exact copy of `tests/integration/opencode-runner-local.test.ts`, with these differences only: the stub path is `tests/fixtures/bin/claude-stub.sh`; the runner is `ClaudeCodeRunner`; the expected session identifier is `ses_claude_1`. Every assertion, including the file write, the redaction, the cancel, and the timeout, stays the same. The identical test body is the proof that the second runner satisfies the same contract.

- [ ] **Step 10: Run the integration test**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/claude-code-runner-local.test.ts`
Expected: PASS, all four tests.

- [ ] **Step 11: Run the repository gates**

Run lint and typecheck. Expected: `exit=0` for both.

- [ ] **Step 12: Commit**

```bash
git add src/adapters/runners/claude-code tests/fixtures/bin/claude-stub.sh tests/unit/claude-output-parser.test.ts tests/unit/claude-code-runner.test.ts tests/integration/claude-code-runner-local.test.ts
git commit -F /tmp/commit-msg.txt
```

The message file holds: `feat(runners): add ClaudeCodeRunner, the second required adapter`.

---

### Task 7: Configuration-driven runner selection

**Files:**
- Modify: `src/domain/runs/agent-runner.ts`
- Modify: `src/activities/sandbox.activities.ts`
- Modify: `src/bin/worker.ts`
- Test: `tests/unit/agent-runner-registry.test.ts`
- Test: `tests/unit/prepare-sandbox-activity.test.ts`

**Interfaces:**
- Produces: `assertKnownRunners(registry: AgentRunnerRegistry, runtime: { implementerRunner: string; validatorRunner: string; reviewerRunner: string }): void`.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/agent-runner-registry.test.ts`:

```ts
describe("assertKnownRunners", () => {
  const runtime = { implementerRunner: "opencode", validatorRunner: "claude", reviewerRunner: "claude" };

  it("accepts a configuration whose runners are all registered", () => {
    const registry = new AgentRunnerRegistry([stub("opencode"), stub("claude")]);
    expect(() => assertKnownRunners(registry, runtime)).not.toThrow();
  });

  it("reports every unknown runner as a configuration fault, not an internal fault", () => {
    const registry = new AgentRunnerRegistry([stub("opencode")]);
    let caught: unknown;
    try {
      assertKnownRunners(registry, runtime);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RunConfigurationError);
    expect(String(caught)).toContain("claude");
    expect(String(caught)).toContain("opencode");
  });

  it("names each unknown runner once, even when two roles name the same one", () => {
    const registry = new AgentRunnerRegistry([stub("opencode")]);
    const message = (() => {
      try {
        assertKnownRunners(registry, runtime);
        return "";
      } catch (error) {
        return String(error);
      }
    })();
    expect(message.match(/"claude"/g)?.length).toBe(1);
  });
});
```

Import `assertKnownRunners` and `RunConfigurationError` at the top of that file.

- [ ] **Step 2: Run it to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/agent-runner-registry.test.ts`
Expected: FAIL, because `assertKnownRunners` does not exist.

- [ ] **Step 3: Write the assertion**

Add to `src/domain/runs/agent-runner.ts`:

```ts
import { RunConfigurationError } from "./run-configuration-error.js";

/**
 * SDD section 14 requires configuration-driven runner selection. A name that no adapter
 * implements is an operator fault, so it must fail where the operator sees it, at preparation,
 * and not deep inside the Implementer activity. Every unknown name reaches the message, so one
 * repair round fixes the whole file.
 */
export const assertKnownRunners = (
  registry: AgentRunnerRegistry,
  runtime: { implementerRunner: string; validatorRunner: string; reviewerRunner: string },
): void => {
  const known = new Set(registry.names());
  const unknown = [...new Set([runtime.implementerRunner, runtime.validatorRunner, runtime.reviewerRunner])]
    .filter((name) => !known.has(name))
    .sort();
  if (unknown.length === 0) return;
  throw new RunConfigurationError(
    `.factoree/config.yaml names an agent runner Factoree does not implement: ` +
      `${unknown.map((name) => `"${name}"`).join(", ")}. ` +
      `The registered runners are: ${registry.names().join(", ")}.`,
  );
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/agent-runner-registry.test.ts`
Expected: PASS, every test.

- [ ] **Step 5: Call it from the prepare activity**

In `src/activities/sandbox.activities.ts`, add `runners: AgentRunnerRegistry;` to `SandboxActivityDependencies`, and in `prepare`, immediately after `sandboxManager.prepare` returns:

```ts
  // SDD section 14. A runner name the repository configured must resolve to a registered
  // adapter. This fault is a configuration fault, so the Run ends `CONFIGURATION_INVALID`.
  assertKnownRunners(dependencies.runners, prepared.runtime);
```

The sandbox must be released when this throws. Place the call inside the same `try` that already releases on a `setSandbox` failure, or wrap it in its own `try` that calls `release` and rethrows. Read the existing body and follow the pattern that is already there.

In `src/activities/index.ts`, pass `runners` into `createSandboxActivities`. The dependency object already holds it.

Add to `tests/unit/prepare-sandbox-activity.test.ts`:

```ts
  it("fails a Run whose configuration names an unknown runner, and releases the sandbox", async () => {
    const dependencies = deps({ runners: new AgentRunnerRegistry([]) });
    await expect(activities(dependencies).prepareSandbox(input())).rejects.toBeInstanceOf(RunConfigurationError);
    expect(dependencies.sandboxManager.released).toBe(true);
  });
```

Read the existing file and adapt the helper names to what it already uses.

- [ ] **Step 6: Register both runners in the worker**

In `src/bin/worker.ts`, change line 76 to:

```ts
// SDD section 33 names two required adapters. A stock `.factoree/config.yaml` selects
// `opencode` for the Implementer and `claude` for the User Validator and the Reviewer, so both
// must be registered before a stock repository can run.
const runners = new AgentRunnerRegistry([new OpenCodeRunner({ redactor }), new ClaudeCodeRunner({ redactor })]);
```

Add the import.

- [ ] **Step 7: Run the affected suites**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run > /tmp/unit.txt 2>&1; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 8: Run the repository gates**

Run lint and typecheck. Expected: `exit=0` for both.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -F /tmp/commit-msg.txt
```

The message file holds: `feat(runners): register both required runners and reject an unknown name`.

---

### Task 8: AT-14, AT-15, AT-37, and the Phase 11 exit condition

**Files:**
- Create: `tests/acceptance/support/runner-fixture.ts`
- Create: `tests/acceptance/at-14-opencode.test.ts`
- Create: `tests/acceptance/at-15-claude-code.test.ts`
- Create: `tests/acceptance/at-37-skills.test.ts`
- Create: `tests/acceptance/phase-11-exit.test.ts`
- Create: `tests/fixtures/bin/claude-liar-stub.sh`

**Interfaces:**
- Consumes: every export of Tasks 1 through 7; `LocalProcessSandbox`; `SandboxManager`; `AgentRunnerRegistry`; `runVerification` and the deterministic verification code of Phase 3.
- Produces: `driveFixtureToVerification(options: { runnerName: string; executable: string; honest: boolean }): Promise<FixtureOutcome>` in `tests/acceptance/support/runner-fixture.ts`.

Read `tests/acceptance/phase-02-exit.test.ts` and `tests/acceptance/phase-03-exit.test.ts` first. They already drive a fixture repository to verification with `OpenCodeRunner`. `runner-fixture.ts` is that same drive, extracted, with the runner and the executable as parameters.

- [ ] **Step 1: Write the shared fixture drive**

Create `tests/acceptance/support/runner-fixture.ts`. It must:

1. create a `LocalProcessSandbox` over a temporary directory;
2. build a git fixture repository that holds `.factoree/config.yaml` with one verification command that fails until the change lands;
3. prepare the sandbox through `SandboxManager`;
4. resolve the runner from an `AgentRunnerRegistry` by `prepared.runtime.implementerRunner`, never by a hard-coded name;
5. run the Implementer;
6. run deterministic verification;
7. return `{ claimedCompleted: boolean; verificationPassed: boolean; runnerName: string; skills: string[] }`.

The registry must hold both runners, each configured with the matching stub executable. The fixture `.factoree/config.yaml` selects the runner under test through `agents.implementer`, so runner selection stays configuration-driven, exactly as SDD section 14 requires.

Copy the fixture repository set-up from `tests/acceptance/phase-03-exit.test.ts` verbatim. Do not invent a second fixture shape.

- [ ] **Step 2: Write AT-14**

Create `tests/acceptance/at-14-opencode.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { driveFixtureToVerification } from "./support/runner-fixture.js";

/**
 * SDD section 64, AT-14. The fixture implementation reaches verification with OpenCodeRunner.
 */
describe("AT-14 — OpenCode", () => {
  it("reaches passing deterministic verification with the opencode runner", async () => {
    const outcome = await driveFixtureToVerification({ runnerName: "opencode", honest: true });
    expect(outcome.runnerName).toBe("opencode");
    expect(outcome.verificationPassed).toBe(true);
  }, 60_000);

  it("blocks a false success claim, because the claim never decides the outcome", async () => {
    const outcome = await driveFixtureToVerification({ runnerName: "opencode", honest: false });
    expect(outcome.claimedCompleted).toBe(true);
    expect(outcome.verificationPassed).toBe(false);
  }, 60_000);
});
```

- [ ] **Step 3: Write AT-15**

Create `tests/acceptance/at-15-claude-code.test.ts` with the identical body, and `runnerName: "claude"` in both cases. The two files must differ only in the runner name and the heading. That identity is the evidence for the Phase 11 exit condition.

Create `tests/fixtures/bin/claude-liar-stub.sh` and make it executable:

```sh
#!/bin/sh
# tests/fixtures/bin/claude-liar-stub.sh
# A Claude Code stand-in that claims success and changes nothing. It writes the same event
# stream as claude-stub.sh, minus the file write, so output-parser.ts accepts it unchanged.
# SDD section 35: the claim does not decide the result.
set -e
/bin/cat > /dev/null
printf '{"type":"system","subtype":"init","session_id":"ses_claude_liar"}\n'
printf '{"type":"result","subtype":"success","session_id":"ses_claude_liar","result":"The change is implemented. Every test passes."}\n'
exit 0
```

- [ ] **Step 4: Run AT-14 and AT-15**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/acceptance/at-14-opencode.test.ts tests/acceptance/at-15-claude-code.test.ts`
Expected: PASS, all four tests.

- [ ] **Step 5: Write AT-37**

Create `tests/acceptance/at-37-skills.test.ts`. It must build a real git fixture that holds:

- `.agents/skills/routes/SKILL.md` with `name: routes`;
- `.claude/skills/tests/SKILL.md` with `name: tests`;
- `.codex/skills/deploy/SKILL.md` with `name: deploy`;
- `.agents/skills/routes/README.md`, which must not become a skill;

and a second real git fixture that serves as the organization skills repository and holds:

- `.agents/skills/routes/SKILL.md` with `name: routes` and a different description;
- `.agents/skills/security/SKILL.md` with `name: security`.

It must prepare a sandbox through `SandboxManager` with `organizationSkills` set to the second fixture, then assert:

```ts
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
```

It must also assert that the skill lines reach the Implementer prompt, by calling `buildImplementerInput` with `skills: prepared.skills` and checking the rendered prompt:

```ts
    const built = buildImplementerInput({ ...implementerFields, skills: prepared.skills });
    expect(built.prompt).toContain('Name conflict: "routes"');
    expect(built.prompt).toContain("SDD section 57 ranks a skill ninth");
```

- [ ] **Step 6: Run AT-37**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/acceptance/at-37-skills.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the Phase 11 exit test**

Create `tests/acceptance/phase-11-exit.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { driveFixtureToVerification } from "./support/runner-fixture.js";

/**
 * SDD section 69, Phase 11 exit: the same fixture workflow works with either required runner.
 *
 * The test drives ONE fixture drive twice, and changes only the runner name in
 * `.factoree/config.yaml`. Nothing else differs, so a pass proves that the workflow itself
 * needed no change for the second runner. SDD section 33 requires exactly that.
 */
describe("Phase 11 exit condition", () => {
  it("reaches passing verification with either required runner, through the same drive", async () => {
    const openCode = await driveFixtureToVerification({ runnerName: "opencode", honest: true });
    const claude = await driveFixtureToVerification({ runnerName: "claude", honest: true });

    expect(openCode.runnerName).toBe("opencode");
    expect(claude.runnerName).toBe("claude");
    expect(openCode.verificationPassed).toBe(true);
    expect(claude.verificationPassed).toBe(true);
  }, 120_000);

  it("blocks a false claim with either required runner", async () => {
    const openCode = await driveFixtureToVerification({ runnerName: "opencode", honest: false });
    const claude = await driveFixtureToVerification({ runnerName: "claude", honest: false });
    expect(openCode.verificationPassed).toBe(false);
    expect(claude.verificationPassed).toBe(false);
  }, 120_000);

  it("names both required adapters of SDD section 33 in the worker registry", async () => {
    const worker = await readFile("src/bin/worker.ts", "utf8");
    expect(worker).toContain("new OpenCodeRunner(");
    expect(worker).toContain("new ClaudeCodeRunner(");
  });

  it("keeps the two runner acceptance tests identical apart from the runner name", async () => {
    const openCode = await readFile("tests/acceptance/at-14-opencode.test.ts", "utf8");
    const claude = await readFile("tests/acceptance/at-15-claude-code.test.ts", "utf8");
    const normalize = (text: string): string =>
      text.replace(/opencode/g, "RUNNER").replace(/claude/g, "RUNNER").replace(/AT-1[45][^\n]*/g, "AT");
    expect(normalize(openCode)).toBe(normalize(claude));
  });
});
```

- [ ] **Step 8: Run the exit test**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/acceptance/phase-11-exit.test.ts`
Expected: PASS, all four tests.

- [ ] **Step 9: Run every suite twice**

Phase 9 and Phase 10 both found a timing failure that one run missed. Run the whole verification twice, in stages, with a real aggregate exit code, as `STATUS.md` requires.

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run verify` through a staged script that redirects each stage to a file and reads `$?` on its own line. Never read an exit code through a pipe.
Expected: `exit=0`, twice, with a skip count of 7.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -F /tmp/commit-msg.txt
```

The message file holds: `test(phase-11): prove AT-14, AT-15, AT-37, and the phase exit condition`.

---

## Spec coverage

| SDD requirement | Task |
| --- | --- |
| Section 16, `.agents/skills` discovery | Tasks 1, 2, 8 |
| Section 16, `.claude/skills` discovery | Tasks 1, 2, 8 |
| Section 16, `.codex/skills` discovery | Tasks 1, 2, 8 |
| Section 16, one organization-wide skills repository | Tasks 3, 4, 8 |
| Section 16, skill origin is recorded | Tasks 1, 2, 8 |
| Section 16, no silent name overwrite | Tasks 1, 2, 8 |
| Section 16 and 57, a skill overrides no higher rule | Task 4 |
| Section 33, `ClaudeCodeRunner` as a required adapter | Task 6 |
| Section 33, a workflow depends only on `AgentRunner` | Tasks 5, 6, 7 |
| Section 34, applicable skills reach the Implementer | Task 4 |
| Section 14, runner selection is configuration-driven | Task 7 |
| Section 30, the prompt never reaches a command line | Task 6 |
| Section 56, a changed prompt template raises the version | Task 4 |
| Section 64, AT-14 | Task 8 |
| Section 64, AT-15 | Task 8 |
| Section 64, AT-37 | Task 8 |
| Section 69, Phase 11 exit condition | Task 8 |
| Definition of Done, OpenCodeRunner passes integration tests | Task 5 |
| Definition of Done, ClaudeCodeRunner passes integration tests | Task 6 |

## Out of scope, later phases, do not build

Tenant isolation hardening, the cross-cutting redaction sweep, concurrency limits, timeout injection, failure injection, the metrics sweep, and the live acceptance test all belong to Phase 12. The live proof of either runner against a real model belongs to Phase 12, because it needs credentials this session does not hold. Every carried finding in `STATUS.md` that Phase 11 does not name stays open. Phase 11 adds no new terminal state and changes no state name.

## Residual risk this plan accepts

1. **Neither runner has run against a real model in this repository.** Both integration tests drive a deterministic stub. That is the honest limit of a phase without credentials, and SDD section 67 gives the live proof to Phase 12.
2. **The organization skills repository is checked out at a branch, not a SHA.** A second Run can therefore read a different skill set. SDD section 20 pins a SHA only where discovery resolves one. Record this as a carried finding.
3. **A skill body never reaches the prompt.** An agent that ignores the path reads no skill content. This is deliberate. See controller decision 6.
