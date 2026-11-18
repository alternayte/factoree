/**
 * GitHub issue 60. SDD section 22 ranks an accepted ADR highest in the architecture domain, and a
 * path names no status. The status a decision record states decides whether it is accepted.
 */
export type AdrStatusReading =
  | { kind: "accepted" }
  | { kind: "not_accepted"; status: string }
  /** The record states no status, or one Factoree does not know. Its path keeps it accepted. */
  | { kind: "unstated" };

const ACCEPTED_STATUSES = new Set(["accepted", "approved", "adopted", "active", "decided", "implemented", "final"]);

const NOT_ACCEPTED_STATUSES = new Set([
  "proposed",
  "draft",
  "in review",
  "under review",
  "in progress",
  "pending",
  "rfc",
  "superseded",
  "deprecated",
  "rejected",
  "withdrawn",
  "obsolete",
  "retired",
  "abandoned",
  "replaced",
]);

/** The status sits near the top of a record, so the reader looks no further than these lines. */
const HEADER_LINES = 60;

const MARKUP = /[*_`"'|]/g;

/** The leading words of a status value, so "Proposed. Needs review" and "Superseded by ADR-7" name one status each. */
const statusWordsOf = (value: string): string | null => {
  const words = value.replace(MARKUP, " ").trim().toLowerCase().match(/^[a-z]+(?: [a-z]+)?/)?.[0];
  if (words === undefined) return null;
  const [first] = words.split(" ");
  return NOT_ACCEPTED_STATUSES.has(words) || ACCEPTED_STATUSES.has(words) ? words : (first ?? null);
};

/** `Status: Accepted`, `- **Status:** Proposed`, `status: draft` in front matter, `"status": "Approved"` in JSON. */
const fieldStatusOf = (lines: readonly string[]): string | null => {
  for (const line of lines) {
    const match = /^\s*(?:[-*]\s+|[{,]\s*)?["*_]*status["*_]*\s*[:=]\s*(.+)$/i.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
};

/** A `## Status` heading, with the status on the first non-empty line below it. */
const headingStatusOf = (lines: readonly string[]): string | null => {
  const heading = lines.findIndex((line) => /^#{1,6}\s*status\s*$/i.test(line.trim()));
  if (heading < 0) return null;
  return lines.slice(heading + 1).find((line) => line.trim().length > 0) ?? null;
};

/** A Markdown table whose header row names a Status column, with the status in the first data row. */
const tableStatusOf = (lines: readonly string[]): string | null => {
  const cellsOf = (line: string): string[] => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim().startsWith("|")) continue;
    const column = cellsOf(line).findIndex((cell) => cell.replace(MARKUP, "").trim().toLowerCase() === "status");
    if (column < 0) continue;
    const row = lines.slice(index + 1).find((candidate) => candidate.trim().startsWith("|") && !/^[\s|:-]+$/.test(candidate));
    return row === undefined ? null : (cellsOf(row)[column] ?? null);
  }
  return null;
};

export const readAdrStatus = (content: string): AdrStatusReading => {
  const lines = content.split(/\r?\n/).slice(0, HEADER_LINES);
  const value = fieldStatusOf(lines) ?? headingStatusOf(lines) ?? tableStatusOf(lines);
  const status = value === null ? null : statusWordsOf(value);
  if (status === null) return { kind: "unstated" };
  if (ACCEPTED_STATUSES.has(status)) return { kind: "accepted" };
  if (NOT_ACCEPTED_STATUSES.has(status)) return { kind: "not_accepted", status };
  return { kind: "unstated" };
};
