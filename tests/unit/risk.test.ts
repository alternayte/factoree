import { describe, expect, it } from "vitest";
import { HIGH_RISK_LABELS, capAutonomy, highRiskLabelsOf } from "~/domain/refinement/risk.js";

describe("highRiskLabelsOf", () => {
  it("lists the SDD section 28 labels", () => {
    expect([...HIGH_RISK_LABELS]).toEqual([
      "security",
      "authentication",
      "authorization",
      "payments",
      "billing",
      "cryptography",
      "database-migration",
      "infrastructure",
      "secrets",
    ]);
  });

  it("matches a label whatever its case and surrounding space", () => {
    expect(highRiskLabelsOf([" Security ", "Backend"])).toEqual(["security"]);
  });

  it("returns each matched label once and in the SDD order", () => {
    expect(highRiskLabelsOf(["secrets", "security", "secrets"])).toEqual(["security", "secrets"]);
  });

  it("returns nothing for an ordinary label", () => {
    expect(highRiskLabelsOf(["frontend"])).toEqual([]);
  });
});

describe("capAutonomy", () => {
  it("keeps the level when no high risk label is present", () => {
    expect(capAutonomy("L3", false)).toBe("L3");
  });

  it("caps a high risk Run at L2", () => {
    expect(capAutonomy("L3", true)).toBe("L2");
  });

  it("does not raise a level below the cap", () => {
    expect(capAutonomy("L0", true)).toBe("L0");
  });

  it("caps L4 to L3, because Version 1 must not merge automatically", () => {
    expect(capAutonomy("L4", false)).toBe("L3");
  });

  it("falls back to L2 for an unknown level", () => {
    expect(capAutonomy("L9", false)).toBe("L2");
  });
});
