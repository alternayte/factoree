import { describe, expect, it } from "vitest";
import {
  conflictQuestion,
  conflictsOf,
  findReportedItem,
  firstUnresolved,
  pairKey,
  pairOfReport,
} from "~/domain/context/conflicts.js";
import type { CheckedConflict, ConflictReport, SelectedContextItem } from "~/domain/context/conflicts.js";
import { conflictDecisionRef } from "~/domain/context/decision-ref.js";
import type { AuthorityClass } from "~/domain/context/authority.js";
import type { ContextClassification } from "~/domain/context/context-source.js";

const item = (ref: string, authority: AuthorityClass, classification: ContextClassification = "reference"): SelectedContextItem => ({
  reference: { sourceId: "repository", ref, repository: "acme/service", sha: "a".repeat(40), path: ref },
  sourceVersion: "a".repeat(40),
  authority,
  reason: "test",
  classification,
  topics: [],
  contentSha256: null,
});

const QUOTE_A = "Notifications are sent through the outbox table.";
const QUOTE_B = "Notifications are published straight to the broker.";

const report = (left: string, right: string, subject = "notification"): ConflictReport => ({
  subject,
  left: { item: left, quote: QUOTE_A },
  right: { item: right, quote: QUOTE_B },
});

const checked = (left: SelectedContextItem, right: SelectedContextItem, subject = "notification"): CheckedConflict => ({
  subject,
  left,
  right,
  leftQuote: QUOTE_A,
  rightQuote: QUOTE_B,
});

describe("pairOfReport", () => {
  it("drops a pair of Work Item texts, as FAC-102 raised on heading (DI-21.53)", () => {
    const items = [item("linear:issue:run-102", "work_item_decision", "required"), item("linear:comments", "work_item_decision", "required")];
    expect(pairOfReport(items, report("linear:issue:run-102", "linear:comments"))).toHaveProperty("dropped");
  });

  it("drops a pair with a documentation item, which never enters a conflict", () => {
    const items = [item("docs/plan-a.md", "documentation"), item("docs/plan-b.md", "documentation")];
    expect(pairOfReport(items, report("docs/plan-a.md", "docs/plan-b.md"))).toEqual({
      dropped: "an item is documentation or not selected, so it never enters a conflict",
    });
  });

  it("drops a pair across authority domains and a pair of combined evidence", () => {
    const across = [item("docs/ADR-1.md", "accepted_adr"), item("openapi.yaml", "machine_readable_contract")];
    expect(pairOfReport(across, report("docs/ADR-1.md", "openapi.yaml"))).toEqual({ dropped: "the items sit in different authority domains" });
    const combined = [item("src/a.ts", "source_code"), item("tests/a.test.ts", "executable_tests")];
    expect(pairOfReport(combined, report("src/a.ts", "tests/a.test.ts"))).toEqual({ dropped: "the items are combined evidence of one behavior" });
  });

  it("drops a discoverable item and an item the contract does not hold", () => {
    const items = [item("docs/ADR-1.md", "accepted_adr", "discoverable"), item("docs/ADR-2.md", "accepted_adr")];
    expect(pairOfReport(items, report("docs/ADR-1.md", "docs/ADR-2.md"))).toHaveProperty("dropped");
    expect(pairOfReport(items, report("docs/ADR-9.md", "docs/ADR-2.md"))).toEqual({
      dropped: "it names an item the Context Contract does not hold",
    });
  });

  it("drops a quote shorter than a passage", () => {
    const items = [item("docs/ADR-1.md", "accepted_adr"), item("docs/ADR-2.md", "accepted_adr")];
    const short = { ...report("docs/ADR-1.md", "docs/ADR-2.md"), left: { item: "docs/ADR-1.md", quote: "the" } };
    expect(pairOfReport(items, short)).toHaveProperty("dropped");
  });

  it("pairs two accepted ADRs", () => {
    const items = [item("docs/ADR-1.md", "accepted_adr"), item("docs/ADR-2.md", "accepted_adr", "required")];
    const pair = pairOfReport(items, report("docs/ADR-1.md", "docs/ADR-2.md"));
    expect("dropped" in pair).toBe(false);
  });
});

describe("findReportedItem", () => {
  it("finds an item by its reference, by owner/repo path, by owner/repo:path, and by a unique path", () => {
    const target = { ...item("repository:acme/service:docs/a.md", "accepted_adr"), reference: { sourceId: "repository", ref: "repository:acme/service:docs/a.md", repository: "acme/service", sha: "a".repeat(40), path: "docs/a.md" } };
    const items = [target];
    expect(findReportedItem(items, "repository:acme/service:docs/a.md")).toBe(target);
    expect(findReportedItem(items, "acme/service docs/a.md")).toBe(target);
    expect(findReportedItem(items, "acme/service:docs/a.md")).toBe(target);
    expect(findReportedItem(items, "docs/a.md")).toBe(target);
    expect(findReportedItem(items, "docs/b.md")).toBeNull();
  });
});

describe("conflictsOf", () => {
  it("resolves a README against an accepted ADR in favour of the ADR (AT-07)", () => {
    const adr = item("docs/ADR-031.md", "accepted_adr");
    const readme = item("README.md", "repository_readme");
    const [conflict] = conflictsOf([checked(readme, adr)], new Map());
    expect(conflict).toMatchObject({
      id: "CTX-1",
      subject: "notification",
      authorityDomain: "architecture_intent",
      winnerRef: "docs/ADR-031.md",
      loserRef: "README.md",
      resolution: "resolved",
    });
    expect(conflict?.reason).toContain("accepted ADR has higher architecture authority than repository README");
    expect(conflict?.reason).toContain(QUOTE_A);
  });

  it("leaves two accepted ADRs unresolved, with both quotes (AT-08)", () => {
    const conflicts = conflictsOf([checked(item("docs/ADR-031.md", "accepted_adr"), item("docs/ADR-042.md", "accepted_adr"))], new Map());
    expect(firstUnresolved(conflicts)).toMatchObject({ winnerRef: null, loserRef: null, refs: ["docs/ADR-031.md", "docs/ADR-042.md"] });
    expect(conflicts[0]?.reason).toContain(QUOTE_A);
    expect(conflicts[0]?.reason).toContain(QUOTE_B);
  });

  it("settles a pair with the answer recorded for the pair, whatever subject the refiner wrote", () => {
    const left = item("docs/ADR-031.md", "accepted_adr");
    const right = item("docs/ADR-042.md", "accepted_adr");
    const ref = conflictDecisionRef("architecture_intent", pairKey("docs/ADR-031.md", "docs/ADR-042.md"));
    const answers = new Map([[ref, { ref, answer: "neither" }]]);
    const [conflict] = conflictsOf([checked(left, right, "delivery")], answers);
    expect(conflict).toMatchObject({ resolution: "resolved", winnerRef: ref, loserRef: null });
    expect(conflict?.reason).toContain('"neither"');
    expect(firstUnresolved(conflictsOf([checked(left, right, "delivery")], answers))).toBeNull();
  });

  it("does not let an answer for another pair settle this pair", () => {
    const ref = conflictDecisionRef("architecture_intent", pairKey("docs/ADR-001.md", "docs/ADR-002.md"));
    const answers = new Map([[ref, { ref, answer: "ADR-001" }]]);
    const conflicts = conflictsOf([checked(item("docs/ADR-031.md", "accepted_adr"), item("docs/ADR-042.md", "accepted_adr"))], answers);
    expect(firstUnresolved(conflicts)).not.toBeNull();
  });

  it("records one conflict per pair and numbers them in a stable order", () => {
    const a = item("docs/ADR-1.md", "accepted_adr");
    const b = item("docs/ADR-2.md", "accepted_adr");
    const c = item("docs/ADR-3.md", "accepted_adr");
    const conflicts = conflictsOf([checked(b, c, "zeta"), checked(a, b, "alpha"), checked(b, a, "alpha")], new Map());
    expect(conflicts.map((conflict) => [conflict.id, conflict.subject])).toEqual([
      ["CTX-1", "alpha"],
      ["CTX-2", "zeta"],
    ]);
  });
});

describe("conflictQuestion", () => {
  it("quotes both passages, names the subject, carries no proposal and offers neither", () => {
    const [conflict] = conflictsOf([checked(item("docs/ADR-031.md", "accepted_adr"), item("docs/ADR-042.md", "accepted_adr"))], new Map());
    if (conflict === undefined) throw new Error("no conflict");
    const question = conflictQuestion(conflict);
    expect(question).toContain('"notification"');
    expect(question).toContain(QUOTE_A);
    expect(question).toContain(QUOTE_B);
    expect(question).toContain('"neither"');
    expect(question).not.toMatch(/Proposal/);
  });
});
