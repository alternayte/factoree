import { WORK_ITEM_COMMENTS_REF } from "./work-item-content.js";
import type { AuthorityClass, AuthorityDomain } from "./authority.js";
import { authorityDomainOf, compareAuthority } from "./authority.js";
import type { ContextClassification, ContextReference } from "./context-source.js";
import { conflictDecisionRef } from "./decision-ref.js";

/** One item the resolver selected. It is the row a Context Contract persists. */
export interface SelectedContextItem {
  reference: ContextReference;
  sourceVersion: string;
  authority: AuthorityClass;
  reason: string;
  classification: ContextClassification;
  topics: string[];
  contentSha256: string | null;
}

/** SDD section 23 fixes this record shape. */
export interface ContextConflictRecord {
  id: string;
  subject: string;
  /**
   * SDD section 22 makes authority domain-specific. The pair sits in one domain, and the domain
   * with the subject names the question a human must answer. The workflow records the domain on
   * the answer, so the answer settles this conflict only.
   */
  authorityDomain: AuthorityDomain;
  winnerRef: string | null;
  loserRef: string | null;
  reason: string;
  resolution: "resolved" | "unresolved";
  /**
   * docs/specs/context-authority-and-cited-conflicts.md. The two item references of the pair,
   * sorted. A human answer is keyed by them. The store keeps no column for it, because only an
   * unresolved conflict needs it, and Factoree never freezes a contract that holds one.
   */
  refs?: [string, string];
}

/** A readable name for an authority class. The recorded reason uses this name. */
const NAMES: Record<string, string> = {
  work_item_decision: "explicit Work Item decision",
  approved_product_specification: "approved product specification",
  product_documentation: "general product documentation",
  accepted_adr: "accepted ADR",
  approved_architecture_specification: "approved architecture specification",
  architecture_documentation: "architecture documentation",
  repository_readme: "repository README",
  machine_readable_contract: "versioned machine-readable contract",
  contract_tests: "executable contract tests",
  api_documentation: "API documentation",
  prose_documentation: "prose documentation",
  source_code: "source code",
  executable_tests: "executable tests",
  runtime_behavior: "runtime behavior",
  declarative_catalog: "declarative catalog",
  repository_configuration: "repository configuration",
};

const DOMAIN_NAMES: Record<string, string> = {
  product_intent: "product",
  architecture_intent: "architecture",
  interface_contract: "interface",
  current_implementation: "implementation",
  system_topology: "topology",
};

const nameOf = (authority: AuthorityClass): string => NAMES[authority] ?? authority;

/**
 * An item can conflict only when Factoree puts it in front of an agent. A `documentation` item is
 * read, but docs/specs/context-authority-and-cited-conflicts.md keeps it out of every conflict.
 */
export const isConflictable = (item: Pick<SelectedContextItem, "classification" | "authority">): boolean =>
  (item.classification === "required" || item.classification === "reference") && item.authority !== "documentation";

/**
 * SDD section 22 writes these two domains with `+`, not with `>`. The specification calls them
 * evidence, so the members combine and never compete. Source code and an executable test tell one
 * story about the same behavior. A pair inside such a domain is therefore no conflict at all.
 * AT-08 reserves the human question for two equally authoritative architecture decisions. This
 * corrects DI-4.8, which a review overturned.
 */
const COMBINED_EVIDENCE_DOMAINS = new Set(["current_implementation", "system_topology"]);

/**
 * docs/specs/work-item-images-and-links.md, DI-21.39. The description, the kept comments and the
 * images are one author's Work Item text. A later sentence supersedes an earlier one on the same
 * point, so two of them never pair as a conflict.
 */
const isWorkItemText = (ref: string): boolean =>
  ref.startsWith("linear:issue:") || ref === WORK_ITEM_COMMENTS_REF || ref.startsWith("linear:image:");

/** The longest quote a report may carry, so a quote stays a passage and never a copy of a file. */
export const CONFLICT_QUOTE_MAX = 400;
/** The shortest quote a report may carry. A few characters occur in almost any file. */
export const CONFLICT_QUOTE_MIN = 20;

/**
 * docs/specs/context-authority-and-cited-conflicts.md. The refiner reports a conflict as data: the
 * subject, and for each side the context item and a passage quoted from it. The report is a
 * claim. Factoree checks it before it records anything.
 */
export interface ConflictReport {
  subject: string;
  left: { item: string; quote: string };
  right: { item: string; quote: string };
}

/** A report whose two items Factoree found and whose two quotes it read in the pinned content. */
export interface CheckedConflict {
  subject: string;
  left: SelectedContextItem;
  right: SelectedContextItem;
  leftQuote: string;
  rightQuote: string;
}

/** A report Factoree dropped, with the reason the log records. */
export interface DroppedConflict {
  report: ConflictReport;
  reason: string;
}

/** Whitespace-insensitive text, so a quote that spans a line break still matches. */
export const normalizeQuote = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The item a report names. The refiner names an item as the Context Contract shows it: its stable
 * reference, `owner/repo path`, `owner/repo:path`, or a path that only one item holds.
 */
export const findReportedItem = (items: readonly SelectedContextItem[], name: string): SelectedContextItem | null => {
  const wanted = name.trim();
  const exact = items.find(
    (item) =>
      item.reference.ref === wanted ||
      (item.reference.repository !== null &&
        item.reference.path !== null &&
        (`${item.reference.repository} ${item.reference.path}` === wanted || `${item.reference.repository}:${item.reference.path}` === wanted)),
  );
  if (exact !== undefined) return exact;
  const byPath = items.filter((item) => item.reference.path === wanted);
  return byPath.length === 1 ? (byPath[0] ?? null) : null;
};

/**
 * The checks a report must pass before Factoree reads its quotes: two different selected items
 * that can conflict, in one SDD section 22 domain that is not combined evidence, and two quotes
 * of a length a passage has. Answers the pair, or the reason to drop the report.
 */
export const pairOfReport = (
  items: readonly SelectedContextItem[],
  report: ConflictReport,
): { left: SelectedContextItem; right: SelectedContextItem } | { dropped: string } => {
  const left = findReportedItem(items, report.left.item);
  const right = findReportedItem(items, report.right.item);
  if (left === null || right === null) return { dropped: "it names an item the Context Contract does not hold" };
  if (left.reference.ref === right.reference.ref) return { dropped: "both sides name one item" };
  if (!isConflictable(left) || !isConflictable(right)) {
    return { dropped: "an item is documentation or not selected, so it never enters a conflict" };
  }
  if (isWorkItemText(left.reference.ref) && isWorkItemText(right.reference.ref)) {
    return { dropped: "both items are Work Item text, where a later sentence supersedes an earlier one" };
  }
  const domain = authorityDomainOf(left.authority);
  if (domain !== authorityDomainOf(right.authority)) return { dropped: "the items sit in different authority domains" };
  if (COMBINED_EVIDENCE_DOMAINS.has(domain)) return { dropped: "the items are combined evidence of one behavior" };
  for (const quote of [report.left.quote, report.right.quote]) {
    const length = normalizeQuote(quote).length;
    if (length < CONFLICT_QUOTE_MIN || length > CONFLICT_QUOTE_MAX) {
      return { dropped: `a quote is not between ${String(CONFLICT_QUOTE_MIN)} and ${String(CONFLICT_QUOTE_MAX)} characters` };
    }
  }
  return { left, right };
};

/** The key of a pair. It names the answer that settles the pair, whatever the subject reads. */
export const pairKey = (left: string, right: string): string => [left, right].sort().join(" | ");

const DECISION_REASON = "a recorded human decision settles this pair";

/**
 * SDD section 23 and docs/specs/context-authority-and-cited-conflicts.md. Each checked report is a
 * real disagreement. A recorded human answer for the pair settles it, and the record carries the
 * answer so every agent that reads the contract reads it. Otherwise SDD section 22 decides: a
 * higher class wins, and two items of one rung leave the conflict unresolved, so a human decides.
 *
 * `answers` maps the decision reference of each answered pair to the answer text. Only a recorded
 * answer settles a pair. The Work Item body is not one.
 */
export const conflictsOf = (
  checked: readonly CheckedConflict[],
  answers: ReadonlyMap<string, { ref: string; answer: string }>,
): ContextConflictRecord[] => {
  const found: Omit<ContextConflictRecord, "id">[] = [];
  const seen = new Set<string>();
  for (const conflict of checked) {
    const { left, right } = conflict;
    const key = pairKey(left.reference.ref, right.reference.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const authorityDomain = authorityDomainOf(left.authority);
    const quoted = `"${left.reference.ref}" says "${conflict.leftQuote}", and "${right.reference.ref}" says "${conflict.rightQuote}"`;
    const answer = answers.get(conflictDecisionRef(authorityDomain, key));
    if (answer !== undefined) {
      found.push({
        subject: conflict.subject,
        authorityDomain,
        winnerRef: answer.ref,
        loserRef: null,
        reason: `${DECISION_REASON}: "${answer.answer}". ${quoted}`,
        resolution: "resolved",
        refs: [left.reference.ref, right.reference.ref].sort() as [string, string],
      });
      continue;
    }
    const order = compareAuthority(left.authority, right.authority);
    if (order === "equal") {
      found.push({
        subject: conflict.subject,
        authorityDomain,
        winnerRef: null,
        loserRef: null,
        reason: `${quoted}. Both are ${nameOf(left.authority)}`,
        resolution: "unresolved",
        refs: [left.reference.ref, right.reference.ref].sort() as [string, string],
      });
      continue;
    }
    if (order === "unrelated") continue;
    const winner = order === "a" ? left : right;
    const loser = order === "a" ? right : left;
    const domain = DOMAIN_NAMES[authorityDomain] ?? "";
    found.push({
      subject: conflict.subject,
      authorityDomain,
      winnerRef: winner.reference.ref,
      loserRef: loser.reference.ref,
      reason: `${nameOf(winner.authority)} has higher ${domain} authority than ${nameOf(loser.authority)}. ${quoted}`,
      resolution: "resolved",
      refs: [left.reference.ref, right.reference.ref].sort() as [string, string],
    });
  }

  // A deterministic order, so the identifiers of one Run stay stable across two resolutions.
  found.sort((a, b) => {
    const left = `${a.subject}|${(a.refs ?? []).join("|")}`;
    const right = `${b.subject}|${(b.refs ?? []).join("|")}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });

  return found.map((conflict, index) => ({ id: `CTX-${index + 1}`, ...conflict }));
};

export const firstUnresolved = (conflicts: ContextConflictRecord[]): ContextConflictRecord | null =>
  conflicts.find((conflict) => conflict.resolution === "unresolved") ?? null;

/**
 * SDD section 23 requires one focused question. It quotes both passages and carries no proposal,
 * because a pick among equals has no reason a reviewer can check. "Neither" settles the pair.
 */
export const conflictQuestion = (conflict: ContextConflictRecord): string =>
  `Two context items disagree on "${conflict.subject}": ${conflict.reason}. ` +
  'Which one governs this change? Reply with one of them, or "neither".';
