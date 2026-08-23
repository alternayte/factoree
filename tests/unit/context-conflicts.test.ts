import { describe, expect, it } from "vitest";
import {
  conflictQuestion,
  detectConflicts,
  firstUnresolved,
} from "~/domain/context/conflicts.js";
import type { SelectedContextItem } from "~/domain/context/conflicts.js";
import type { AuthorityClass } from "~/domain/context/authority.js";
import type { ContextClassification } from "~/domain/context/context-source.js";

const item = (
  ref: string,
  authority: AuthorityClass,
  topics: string[],
  classification: ContextClassification = "reference",
): SelectedContextItem => ({
  reference: { sourceId: "repository", ref, repository: "acme/service", sha: "a".repeat(40), path: ref },
  sourceVersion: "a".repeat(40),
  authority,
  reason: "test",
  classification,
  topics,
  contentSha256: null,
});

describe("detectConflicts", () => {
  it("resolves a README against an accepted ADR in favour of the ADR", () => {
    const conflicts = detectConflicts([
      item("docs/ADR-031.md", "accepted_adr", ["notification"]),
      item("README.md", "repository_readme", ["notification"]),
    ]);
    expect(conflicts).toEqual([
      {
        id: "CTX-1",
        subject: "notification",
        winnerRef: "docs/ADR-031.md",
        loserRef: "README.md",
        reason: "accepted ADR has higher architecture authority than repository README",
        resolution: "resolved",
      },
    ]);
  });

  it("reports two accepted ADRs as unresolved", () => {
    const conflicts = detectConflicts([
      item("docs/ADR-031.md", "accepted_adr", ["notification"]),
      item("docs/ADR-042.md", "accepted_adr", ["notification"]),
    ]);
    expect(conflicts[0]?.resolution).toBe("unresolved");
    expect(conflicts[0]?.winnerRef).toBeNull();
    expect(conflicts[0]?.loserRef).toBeNull();
    expect(conflicts[0]?.reason).toMatch(/equally authoritative/);
    expect(conflicts[0]?.reason).toContain("docs/ADR-031.md");
    expect(conflicts[0]?.reason).toContain("docs/ADR-042.md");
  });

  it("does not pair two items of different authority domains", () => {
    expect(
      detectConflicts([
        item("docs/ADR-031.md", "accepted_adr", ["notification"]),
        item("openapi.yaml", "machine_readable_contract", ["notification"]),
      ]),
    ).toEqual([]);
  });

  it("does not pair two items that share no topic", () => {
    expect(
      detectConflicts([
        item("docs/ADR-031.md", "accepted_adr", ["notification"]),
        item("README.md", "repository_readme", ["billing"]),
      ]),
    ).toEqual([]);
  });

  it("does not pair a discoverable item", () => {
    expect(
      detectConflicts([
        item("docs/ADR-031.md", "accepted_adr", ["notification"]),
        item("README.md", "repository_readme", ["notification"], "discoverable"),
      ]),
    ).toEqual([]);
  });

  it("pairs a required item with a reference item", () => {
    const conflicts = detectConflicts([
      item("docs/ADR-031.md", "accepted_adr", ["notification"], "required"),
      item("README.md", "repository_readme", ["notification"], "reference"),
    ]);
    expect(conflicts).toHaveLength(1);
  });

  it("uses the first shared topic in sorted order as the subject", () => {
    const conflicts = detectConflicts([
      item("docs/ADR-031.md", "accepted_adr", ["queue", "notification"]),
      item("README.md", "repository_readme", ["notification", "queue"]),
    ]);
    expect(conflicts[0]?.subject).toBe("notification");
  });

  it("numbers every conflict from one in a deterministic order", () => {
    const conflicts = detectConflicts([
      item("README.md", "repository_readme", ["queue"]),
      item("docs/ADR-031.md", "accepted_adr", ["queue"]),
      item("docs/ADR-042.md", "accepted_adr", ["billing"]),
      item("docs/other.md", "architecture_documentation", ["billing"]),
    ]);
    expect(conflicts.map((conflict) => [conflict.id, conflict.subject])).toEqual([
      ["CTX-1", "billing"],
      ["CTX-2", "queue"],
    ]);
  });

  it("returns nothing for a single item", () => {
    expect(detectConflicts([item("README.md", "repository_readme", ["queue"])])).toEqual([]);
  });

  it("treats a conflict as resolved when a recorded human decision covers the subject", () => {
    const conflicts = detectConflicts([
      item("docs/ADR-031.md", "accepted_adr", ["notification"]),
      item("docs/ADR-042.md", "accepted_adr", ["notification"]),
      item("linear:decision:CTX-1", "work_item_decision", ["notification"], "required"),
    ], { decisionRefs: ["linear:decision:CTX-1"] });
    const unresolved = conflicts.filter((conflict) => conflict.resolution === "unresolved");
    expect(unresolved).toEqual([]);
    const settled = conflicts.find((conflict) => conflict.subject === "notification");
    expect(settled?.winnerRef).toBe("linear:decision:CTX-1");
    expect(settled?.reason).toBe("a recorded human decision settles this subject");
  });

  it("lets a decision recorded against one subject leave another subject unresolved", () => {
    // SDD section 23 makes a human answer decisive for the question Factoree asked. The answer
    // carries that subject only, so a second subject the human never saw stays open.
    const conflicts = detectConflicts(
      [
        item("docs/ADR-031.md", "accepted_adr", ["notification"]),
        item("docs/ADR-042.md", "accepted_adr", ["notification"]),
        item("docs/ADR-051.md", "accepted_adr", ["billing"]),
        item("docs/ADR-052.md", "accepted_adr", ["billing"]),
        item("linear:decision:subject:billing", "work_item_decision", ["billing"], "required"),
      ],
      { decisionRefs: ["linear:decision:subject:billing"] },
    );
    const billing = conflicts.find((conflict) => conflict.subject === "billing");
    expect(billing?.resolution).toBe("resolved");
    expect(billing?.reason).toBe("a recorded human decision settles this subject");
    const notification = conflicts.find((conflict) => conflict.subject === "notification");
    expect(notification?.resolution).toBe("unresolved");
    expect(notification?.winnerRef).toBeNull();
  });

  it("keeps the authority ladder reason when an unrelated decision exists", () => {
    const conflicts = detectConflicts(
      [
        item("docs/ADR-031.md", "accepted_adr", ["notification"]),
        item("README.md", "repository_readme", ["notification"]),
        item("linear:decision:subject:billing", "work_item_decision", ["billing"], "required"),
      ],
      { decisionRefs: ["linear:decision:subject:billing"] },
    );
    expect(conflicts).toEqual([
      {
        id: "CTX-1",
        subject: "notification",
        winnerRef: "docs/ADR-031.md",
        loserRef: "README.md",
        reason: "accepted ADR has higher architecture authority than repository README",
        resolution: "resolved",
      },
    ]);
  });

  it("settles nothing for a recorded answer that carries no subject", () => {
    // A refinement answer settles no conflict, so the Linear source gives it no topic. It stays
    // a required context item, and every conflict stays open.
    const conflicts = detectConflicts(
      [
        item("docs/ADR-031.md", "accepted_adr", ["notification"]),
        item("docs/ADR-042.md", "accepted_adr", ["notification"]),
        item("linear:decision:Q-1", "work_item_decision", [], "required"),
      ],
      { decisionRefs: ["linear:decision:Q-1"] },
    );
    expect(conflicts.map((conflict) => conflict.resolution)).toEqual(["unresolved"]);
  });

  it("records no conflict between the Work Item body and a recorded answer to it", () => {
    // Both carry `work_item_decision` and every topic of the Run. A recorded answer is an
    // override, not a competitor, so the pair must produce nothing.
    const conflicts = detectConflicts(
      [
        item("linear:issue:run-1", "work_item_decision", ["notification"], "required"),
        item("linear:decision:CTX-1", "work_item_decision", ["notification"], "required"),
      ],
      { decisionRefs: ["linear:decision:CTX-1"] },
    );
    expect(conflicts).toEqual([]);
  });

  it("records no conflict between two recorded answers that share a topic", () => {
    const conflicts = detectConflicts(
      [
        item("linear:decision:CTX-1", "work_item_decision", ["notification"], "required"),
        item("linear:decision:CTX-2", "work_item_decision", ["notification"], "required"),
      ],
      { decisionRefs: ["linear:decision:CTX-1", "linear:decision:CTX-2"] },
    );
    expect(conflicts).toEqual([]);
  });

  it("still lets a recorded answer settle a conflict between two accepted ADRs", () => {
    const conflicts = detectConflicts(
      [
        item("docs/ADR-031.md", "accepted_adr", ["notification"]),
        item("docs/ADR-042.md", "accepted_adr", ["notification"]),
        item("linear:issue:run-1", "work_item_decision", ["notification"], "required"),
        item("linear:decision:CTX-1", "work_item_decision", ["notification"], "required"),
      ],
      { decisionRefs: ["linear:decision:CTX-1"] },
    );
    expect(conflicts).toEqual([
      {
        id: "CTX-1",
        subject: "notification",
        winnerRef: "linear:decision:CTX-1",
        loserRef: null,
        reason: "a recorded human decision settles this subject",
        resolution: "resolved",
      },
    ]);
  });

  it("lets no item settle a conflict when the caller names no recorded decision", () => {
    // The Work Item body carries the `work_item_decision` class and answers no question. An
    // absent `decisionRefs` list therefore settles nothing.
    const conflicts = detectConflicts([
      item("docs/ADR-031.md", "accepted_adr", ["notification"]),
      item("docs/ADR-042.md", "accepted_adr", ["notification"]),
      item("linear:issue:run-1", "work_item_decision", ["notification"], "required"),
    ]);
    expect(conflicts.find((conflict) => conflict.subject === "notification")?.resolution).toBe(
      "unresolved",
    );
  });

  it("does not pair two items of one combined evidence domain", () => {
    // SDD section 22 joins source code and an executable test with `+`. They are evidence about
    // one behavior, so they never compete.
    expect(
      detectConflicts([
        item("src/retry.ts", "source_code", ["retry"]),
        item("tests/retry.test.ts", "executable_tests", ["retry"]),
      ]),
    ).toEqual([]);
  });

  it("does not let a decision on another subject settle this conflict", () => {
    const conflicts = detectConflicts([
      item("docs/ADR-031.md", "accepted_adr", ["notification"]),
      item("docs/ADR-042.md", "accepted_adr", ["notification"]),
      item("linear:decision:CTX-9", "work_item_decision", ["billing"], "required"),
    ], { decisionRefs: ["linear:decision:CTX-9"] });
    const settled = conflicts.find((conflict) => conflict.subject === "notification");
    expect(settled?.resolution).toBe("unresolved");
    expect(settled?.winnerRef).toBeNull();
  });
});

describe("firstUnresolved", () => {
  it("returns the first unresolved conflict", () => {
    const conflicts = detectConflicts([
      item("README.md", "repository_readme", ["queue"]),
      item("docs/ADR-031.md", "accepted_adr", ["queue"]),
      item("docs/ADR-042.md", "accepted_adr", ["billing"]),
      item("docs/ADR-055.md", "accepted_adr", ["billing"]),
    ]);
    expect(firstUnresolved(conflicts)?.subject).toBe("billing");
  });

  it("returns null when every conflict resolved", () => {
    const conflicts = detectConflicts([
      item("README.md", "repository_readme", ["queue"]),
      item("docs/ADR-031.md", "accepted_adr", ["queue"]),
    ]);
    expect(firstUnresolved(conflicts)).toBeNull();
  });

  it("returns null once a recorded human decision settles the remaining conflict", () => {
    const conflicts = detectConflicts([
      item("docs/ADR-031.md", "accepted_adr", ["billing"]),
      item("docs/ADR-042.md", "accepted_adr", ["billing"]),
      item("linear:decision:CTX-1", "work_item_decision", ["billing"], "required"),
    ], { decisionRefs: ["linear:decision:CTX-1"] });
    expect(firstUnresolved(conflicts)).toBeNull();
  });
});

describe("conflictQuestion", () => {
  it("asks one focused question that names both references and the subject", () => {
    const conflicts = detectConflicts([
      item("docs/ADR-031.md", "accepted_adr", ["notification"]),
      item("docs/ADR-042.md", "accepted_adr", ["notification"]),
    ]);
    const conflict = conflicts[0];
    if (conflict === undefined) throw new Error("expected one conflict");
    const question = conflictQuestion(conflict);
    expect(question).toContain("docs/ADR-031.md");
    expect(question).toContain("docs/ADR-042.md");
    expect(question).toContain("notification");
    expect(question.endsWith("?")).toBe(true);
  });
});
