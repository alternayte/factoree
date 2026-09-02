import { describe, expect, it } from "vitest";
import { methodFor } from "~/domain/validation/validation-contract-builder.js";
import { parseWorkItem } from "~/domain/refinement/work-item.js";
import { fixtureDescription } from "../live/scenario.js";

/**
 * SDD section 36 forbids an L3 Run from completing while one assertion needs a human, so a
 * fixture issue whose acceptance criteria read as prose ends every live acceptance Run at user
 * validation. A real Run proved it: three criteria, three `MANUAL_REQUIRED` results, no pull
 * request. These tests hold the fixture to criteria the User Validator can prove by itself.
 */
const criteriaOf = (description: string): string[] =>
  description
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));

describe("the live acceptance fixture issue", () => {
  const token = "factoree-live-2026-08-27T20-40-00-000Z";
  const description = fixtureDescription(token);

  it("states its criteria under a heading refinement recognises", () => {
    // A plain "Acceptance criteria:" line names no section, and refinement then derives one
    // criterion from every sentence of the issue, the title included. A real Run proved it: two
    // command assertions and four manual ones, so the Run still ended at user validation.
    const item = parseWorkItem({
      title: `Factoree live acceptance fixture ${token}`,
      description,
      labels: [],
      issueId: "issue-1",
      url: "https://linear.app/factoree/issue/issue-1",
    });

    expect(item.acceptanceCriteria).toHaveLength(2);
    for (const criterion of item.acceptanceCriteria) {
      expect(methodFor(criterion.statement), criterion.statement).toBe("command");
    }
  });

  it("states every acceptance criterion as a command", () => {
    const criteria = criteriaOf(description);
    expect(criteria.length).toBeGreaterThan(0);
    for (const criterion of criteria) {
      expect(methodFor(criterion), criterion).toBe("command");
    }
  });

  it("names the token, so a file an earlier Run left behind cannot pass this one", () => {
    expect(description).toContain("factoree-live-2026-08-27T20-40-00-000Z");
  });

  it("uses no word that selects another validation method", () => {
    // `test -f` reads as the `test` method and sends the validator to the test suite instead.
    for (const criterion of criteriaOf(description)) {
      expect(methodFor(criterion), criterion).not.toBe("test");
      expect(methodFor(criterion), criterion).not.toBe("manual");
    }
  });
});
