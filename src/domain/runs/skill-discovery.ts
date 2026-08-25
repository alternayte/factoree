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
