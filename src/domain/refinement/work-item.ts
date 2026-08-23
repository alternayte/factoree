/**
 * SDD section 7 recommends a Work Item structure. It recommends that Factoree accept an
 * imperfect ticket. This parser therefore reads the recommended structure when it is present
 * and degrades to "the whole body is the goal" when it is not. It never rewrites text, because
 * SDD section 7 forbids Factoree from inventing material product behavior.
 */

export interface WorkItemSource {
  issueId: string | null;
  title: string;
  description: string;
  url: string | null;
  labels: string[];
}

export interface WorkItemReference {
  kind: "url" | "repository" | "text";
  value: string;
}

export interface AcceptanceCriterion {
  id: string;
  statement: string;
  /** SDD section 8 requires the origin of a proposed criterion. */
  source: string;
}

export interface WorkItem {
  goal: string;
  acceptanceCriteria: AcceptanceCriterion[];
  constraints: string[];
  references: WorkItemReference[];
  openQuestions: string[];
  labels: string[];
  issueId: string | null;
  url: string | null;
}

/**
 * An `owner/repo` slug. Each half permits a letter, a digit, a dot, an underscore, and a
 * hyphen, and no half is a bare dot segment. `buildRepositoryUrl` applies the same rule, so a
 * slug this parser accepts is a slug a checkout can use.
 */
export const REPOSITORY_SLUG = /^(?!\.{1,2}\/)[A-Za-z0-9._-]+\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

type SectionName = "goal" | "acceptance" | "constraints" | "references" | "questions";

const HEADING = /^#{1,6}\s+(.*)$/;

const SECTION_BY_TITLE = new Map<string, SectionName>([
  ["goal", "goal"],
  ["acceptance criteria", "acceptance"],
  ["acceptance criterion", "acceptance"],
  ["constraints", "constraints"],
  ["references", "references"],
  ["open questions", "questions"],
]);

/** Lowercases a heading and removes the trailing punctuation an author often adds. */
const headingKey = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[:.*_`]+/g, "")
    .trim();

/**
 * Splits the body into the recognised sections. Unrecognised headings stay inside their
 * section. Text before the first recognised heading is a preamble the author wrote without a
 * section marker, so this function folds it into the goal section, ahead of any `## Goal` text.
 */
const splitSections = (body: string): Map<SectionName, string[]> => {
  const sections = new Map<SectionName, string[]>();
  const preamble: string[] = [];
  let current: SectionName | null = null;
  for (const line of body.split("\n")) {
    const heading = HEADING.exec(line);
    const named = heading === null ? undefined : SECTION_BY_TITLE.get(headingKey(heading[1] ?? ""));
    if (named !== undefined) {
      current = named;
      if (!sections.has(named)) sections.set(named, []);
      continue;
    }
    if (current === null) {
      preamble.push(line);
      continue;
    }
    sections.get(current)?.push(line);
  }
  const preambleText = preamble.join("\n").trim();
  if (preambleText !== "") {
    const goalText = (sections.get("goal") ?? []).join("\n").trim();
    const merged = goalText === "" ? preambleText : `${preambleText}\n\n${goalText}`;
    sections.set("goal", merged.split("\n"));
  }
  return sections;
};

const textOf = (sections: Map<SectionName, string[]>, name: SectionName): string =>
  (sections.get(name) ?? []).join("\n").trim();

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/** The list items of a section. Empty when the section holds no list. */
const listItemsOf = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => LIST_ITEM.exec(line)?.[1]?.trim() ?? null)
    .filter((item): item is string => item !== null && item !== "");

/** The non-empty lines of a section, with any list marker removed. */
const linesOf = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => (LIST_ITEM.exec(line)?.[1] ?? line).trim())
    .filter((line) => line !== "");

/** The list items when the section holds a list, and its plain lines otherwise. */
const itemsOf = (text: string): string[] => {
  const items = listItemsOf(text);
  return items.length > 0 ? items : linesOf(text);
};

const AC_MARKER = /^(AC-\d+)\s*[:.\-–]\s*(.*)$/i;

const acceptanceCriteriaOf = (text: string, source: string): AcceptanceCriterion[] =>
  itemsOf(text).map((item, index) => {
    const marked = AC_MARKER.exec(item);
    const statement = marked?.[2]?.trim();
    // A marked item keeps its own identifier. An unmarked item is numbered by its position, so
    // two unmarked items can never collide.
    if (marked !== null && statement !== undefined && statement !== "") {
      return { id: (marked[1] ?? "").toUpperCase(), statement, source };
    }
    return { id: `AC-${index + 1}`, statement: item, source };
  });

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const BARE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+$/;

const referenceOf = (value: string): WorkItemReference => {
  if (BARE_URL.test(value)) return { kind: "url", value };
  if (REPOSITORY_SLUG.test(value)) return { kind: "repository", value };
  return { kind: "text", value };
};

const referencesOf = (text: string): WorkItemReference[] => {
  const values: string[] = [];
  for (const item of itemsOf(text)) {
    const links = [...item.matchAll(MARKDOWN_LINK)].map((match) => match[1] ?? "");
    // A markdown link hides its target inside the line, so the target replaces the line. A line
    // with no link is itself the reference.
    if (links.length > 0) values.push(...links);
    else values.push(item);
  }
  const seen = new Set<string>();
  const references: WorkItemReference[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    references.push(referenceOf(trimmed));
  }
  return references;
};

/**
 * SDD section 8 requires Factoree to identify a missing decision rather than choose one. A line
 * that ends in a question mark is the one marker an author writes on their own initiative.
 */
const questionLinesOf = (text: string): string[] =>
  linesOf(text).filter((line) => line.endsWith("?"));

export const parseWorkItem = (source: WorkItemSource): WorkItem => {
  const title = source.title.trim();
  const body = source.description.trim();
  const sections = splitSections(body);
  const hasSection = sections.size > 0;

  const goalSection = hasSection ? textOf(sections, "goal") : body;
  const goal = [title, goalSection].filter((part) => part !== "").join("\n\n");

  const acceptanceText = textOf(sections, "acceptance");
  const constraintsText = textOf(sections, "constraints");
  const referencesText = textOf(sections, "references");
  const questionsText = textOf(sections, "questions");

  const criterionSource = `linear:${source.issueId ?? "unknown"}`;

  const openQuestions = [
    ...itemsOf(questionsText),
    ...questionLinesOf(goalSection),
    ...questionLinesOf(constraintsText),
    ...questionLinesOf(acceptanceText),
  ].filter((question, index, all) => question !== "" && all.indexOf(question) === index);

  return {
    goal,
    acceptanceCriteria: acceptanceCriteriaOf(acceptanceText, criterionSource),
    constraints: itemsOf(constraintsText),
    references: referencesOf(referencesText),
    openQuestions,
    labels: [...source.labels],
    issueId: source.issueId,
    url: source.url,
  };
};
