import { describe, expect, it } from "vitest";
import {
  RUN_FAILURE_CATEGORIES,
  failureCategoryOf,
  type RunFailureCategory,
} from "~/domain/runs/failure-category.js";
import { RUN_FAILURE_REASONS } from "~/domain/runs/run-status.js";

describe("the normalized failure category", () => {
  it("maps every failure reason to a declared category", () => {
    // SDD section 67: "Failed Runs have normalized failure categories." A reason with no
    // category would reach the metric and the Run row as `undefined`, which normalizes nothing.
    const declared = new Set<string>(RUN_FAILURE_CATEGORIES);
    for (const reason of RUN_FAILURE_REASONS) {
      const category: RunFailureCategory = failureCategoryOf(reason);
      expect(declared.has(category), `${reason} has no declared category`).toBe(true);
    }
  });

  it("uses every declared category, so no category is dead", () => {
    const used = new Set(RUN_FAILURE_REASONS.map((reason) => failureCategoryOf(reason)));
    expect([...used].sort()).toEqual([...RUN_FAILURE_CATEGORIES].sort());
  });

  it("separates the states an operator acts on differently", () => {
    // A timeout needs a longer budget. A configuration fault needs an edited file. A review
    // block needs a human decision. Three separate categories keep those three apart.
    expect(failureCategoryOf("RUN_TIMEOUT")).toBe("TIMEOUT");
    expect(failureCategoryOf("CONFIGURATION_INVALID")).toBe("CONFIGURATION");
    expect(failureCategoryOf("REVIEW_BLOCKING_FINDINGS")).toBe("REVIEW");
    expect(failureCategoryOf("STOPPED_BY_HUMAN")).toBe("CANCELLED");
  });

  it("groups the three unresolved-input reasons under one category", () => {
    // SDD section 8, section 9, and section 23 all end the same way: a human must answer.
    expect(failureCategoryOf("REFINEMENT_UNRESOLVED")).toBe("INPUT_UNRESOLVED");
    expect(failureCategoryOf("CONTEXT_UNRESOLVED")).toBe("INPUT_UNRESOLVED");
    expect(failureCategoryOf("VALIDATION_UNRESOLVED")).toBe("INPUT_UNRESOLVED");
  });

  it("groups every publication reason under one category", () => {
    expect(failureCategoryOf("PATCH_HASH_MISMATCH")).toBe("PUBLICATION");
    expect(failureCategoryOf("EMPTY_PATCH")).toBe("PUBLICATION");
    expect(failureCategoryOf("PUBLICATION_FAILED")).toBe("PUBLICATION");
  });
});
