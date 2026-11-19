/**
 * docs/specs/context-authority-and-cited-conflicts.md. SDD section 22 ranks an accepted ADR highest
 * in the architecture domain, and a path names no status. The status the record states decides its
 * class:
 *
 * - `accepted`: the record is an accepted ADR.
 * - `documentation`: the record is proposed, a draft, states an unknown status, or states none.
 *   Authority needs a recorded acceptance.
 * - `excluded`: the record is superseded, deprecated or rejected. Factoree does not select it, so it
 *   can never win the ladder.
 *
 * The reader looks at the front matter, then at the header lines before the first section
 * heading, then at the first Status section. It skips fenced code, so a `status:` line in an
 * example block never decides. A status value that names "superseded" wins over "accepted", so
 * "Accepted, superseded by ADR-12" is excluded.
 */
export type AdrStatus = "accepted" | "documentation" | "excluded";

const EXCLUDED = /\b(superseded|deprecated|rejected|withdrawn|obsolete|retired|abandoned|replaced)\b/;
const NOT_ACCEPTED = /\bnot\s+(accepted|approved|adopted)\b/;
const ACCEPTED = /\b(accepted|approved|adopted|active|decided|implemented|final)\b/;

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const STATUS_HEADING = /^status\s*:?\s*(.*)$/i;
/** `Status: Accepted`, `- **Status:** Proposed`, `* Status: accepted`, `| Status | Accepted |`. */
const STATUS_FIELD = /^\s*(?:[-*+]\s+)?(?:\|\s*)?[*_]*status[*_]*\s*(?::[*_]*|\|)\s*(.+)$/i;
/** `"status": "Approved"` anywhere on a line, as in JSON metadata. */
const JSON_FIELD = /"status"\s*:\s*"([^"]*)"/i;

const valueOf = (raw: string): AdrStatus => {
  const value = raw.replace(/[*_`"'|[\]]/g, " ").toLowerCase();
  if (EXCLUDED.test(value)) return "excluded";
  if (NOT_ACCEPTED.test(value)) return "documentation";
  if (ACCEPTED.test(value)) return "accepted";
  return "documentation";
};

/** The lines outside fenced code blocks, in order. */
const unfenced = (lines: readonly string[]): string[] => {
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept;
};

/** The `status` key of a YAML front matter block at the top of the file, or null. */
const frontMatterStatus = (lines: readonly string[]): string | null => {
  if (lines[0]?.trim() !== "---") return null;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "---" || line.trim() === "...") return null;
    const match = /^status\s*:\s*(.*)$/i.exec(line.trim());
    if (match !== null) return match[1] ?? "";
  }
  return null;
};

/** The end of a front matter block, so the header scan starts after it. */
const bodyStart = (lines: readonly string[]): number => {
  if (lines[0]?.trim() !== "---") return 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (line === "---" || line === "...") return index + 1;
  }
  return 0;
};

/** A status field among the lines before the first section heading. The title heading is level 1. */
const headerFieldStatus = (lines: readonly string[]): string | null => {
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading !== null && !/^\s{0,3}#\s/.test(line)) {
      // A `## Status` heading ends the header. The section reader takes it from here.
      return null;
    }
    const field = STATUS_FIELD.exec(line);
    if (field?.[1] !== undefined && field[1].trim().length > 0) return field[1];
    const json = JSON_FIELD.exec(line);
    if (json?.[1] !== undefined) return json[1];
  }
  return null;
};

/** The text of the first Status section: the heading's own value, or the lines up to the next heading. */
const statusSection = (lines: readonly string[]): string | null => {
  const start = lines.findIndex((line) => {
    const heading = HEADING.exec(line);
    return heading !== null && STATUS_HEADING.test(heading[1] ?? "");
  });
  if (start < 0) return null;
  const inline = STATUS_HEADING.exec(HEADING.exec(lines[start] ?? "")?.[1] ?? "")?.[1] ?? "";
  if (inline.trim().length > 0) return inline;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line)) break;
    if (line.trim().length > 0) body.push(line);
  }
  return body.length === 0 ? null : body.join(" ");
};

export const readAdrStatus = (content: string): AdrStatus => {
  const lines = content.replace(/^﻿/, "").split(/\r?\n/);
  const front = frontMatterStatus(lines);
  if (front !== null) return valueOf(front);
  const body = unfenced(lines.slice(bodyStart(lines)));
  const value = headerFieldStatus(body) ?? statusSection(body);
  return value === null ? "documentation" : valueOf(value);
};
