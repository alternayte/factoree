import type { AuthorityClass } from "./authority.js";
import { authorityDomainOf, compareAuthority } from "./authority.js";
import type { ContextClassification, ContextReference } from "./context-source.js";

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
  winnerRef: string | null;
  loserRef: string | null;
  reason: string;
  resolution: "resolved" | "unresolved";
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

/** An item can conflict only when Factoree puts it in front of an agent. */
const conflictable = (classification: ContextClassification): boolean =>
  classification === "required" || classification === "reference";

/** The reason text for the human-decision rule below. Task 10 matches on this exact string. */
const DECISION_REASON = "a recorded human decision settles this subject";

/**
 * SDD section 23. Factoree must record a material conflict. It can resolve a conflict
 * automatically only when authority policy gives a clear winner.
 *
 * The detector is deterministic by design. Two selected items conflict when they sit in one
 * authority domain and both carry the same Work Item topic. SDD section 8 forbids Refinement
 * from resolving an ambiguous architecture choice silently. A similarity model would guess, so
 * it is the wrong control here. The domain-and-topic rule never guesses.
 *
 * A separate rule then applies. SDD section 22 makes an explicit Work Item decision the highest
 * product-intent authority, and SDD section 23 requires the human answer to persist as a Run
 * decision that governs the Run. So when the item list holds a `work_item_decision` item whose
 * topics include a conflict subject, that conflict is resolved by the decision, whatever the
 * ordinary domain pairing found. A decision item sits in the product-intent domain, so it never
 * pairs with an architecture-intent conflict through the domain rule alone. This second rule is
 * a subject check, not a pairing, and it is why the workflow can make progress after one human
 * answer instead of asking the same question again.
 */
export const detectConflicts = (items: SelectedContextItem[]): ContextConflictRecord[] => {
  const candidates = items.filter((item) => conflictable(item.classification));
  const decisions = candidates
    .filter((item) => item.authority === "work_item_decision")
    .sort((a, b) => (a.reference.ref < b.reference.ref ? -1 : a.reference.ref > b.reference.ref ? 1 : 0));
  const found: Omit<ContextConflictRecord, "id">[] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i];
      const right = candidates[j];
      if (left === undefined || right === undefined) continue;
      if (left.reference.ref === right.reference.ref) continue;
      if (authorityDomainOf(left.authority) !== authorityDomainOf(right.authority)) continue;

      const shared = left.topics.filter((topic) => right.topics.includes(topic)).sort();
      const subject = shared[0];
      if (subject === undefined) continue;

      const decision = decisions.find((item) => item.topics.includes(subject));
      if (decision !== undefined) {
        found.push({
          subject,
          winnerRef: decision.reference.ref,
          loserRef: null,
          reason: DECISION_REASON,
          resolution: "resolved",
        });
        continue;
      }

      const order = compareAuthority(left.authority, right.authority);
      if (order === "unrelated") continue;

      if (order === "equal") {
        // SDD section 23. No safe resolution exists, so a human must decide.
        const [first, second] = [left.reference.ref, right.reference.ref].sort();
        found.push({
          subject,
          winnerRef: null,
          loserRef: null,
          reason:
            `"${first}" and "${second}" are equally authoritative ` +
            `${nameOf(left.authority)} sources for "${subject}"`,
          resolution: "unresolved",
        });
        continue;
      }

      const winner = order === "a" ? left : right;
      const loser = order === "a" ? right : left;
      const domain = DOMAIN_NAMES[authorityDomainOf(left.authority)] ?? "";
      found.push({
        subject,
        winnerRef: winner.reference.ref,
        loserRef: loser.reference.ref,
        reason: `${nameOf(winner.authority)} has higher ${domain} authority than ${nameOf(loser.authority)}`,
        resolution: "resolved",
      });
    }
  }

  // A deterministic order, so the identifiers of one Run stay stable across two resolutions.
  found.sort((a, b) => {
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
    const left = `${a.winnerRef ?? ""}|${a.loserRef ?? ""}|${a.reason}`;
    const right = `${b.winnerRef ?? ""}|${b.loserRef ?? ""}|${b.reason}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });

  return found.map((conflict, index) => ({ id: `CTX-${index + 1}`, ...conflict }));
};

export const firstUnresolved = (conflicts: ContextConflictRecord[]): ContextConflictRecord | null =>
  conflicts.find((conflict) => conflict.resolution === "unresolved") ?? null;

/** SDD section 23 requires one focused question. */
export const conflictQuestion = (conflict: ContextConflictRecord): string =>
  `${conflict.reason}. Which one governs "${conflict.subject}" for this change, and why?`;
