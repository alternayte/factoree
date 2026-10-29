import { describe, expect, it } from "vitest";
import { HIGH_RISK_LABELS, decideAutonomy, highRiskLabelsOf } from "~/domain/refinement/risk.js";

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

describe("decideAutonomy", () => {
  const level = (defaultLevel: string, labels: string[], caps: Record<string, string> | null = null) =>
    decideAutonomy({ defaultLevel, labels, riskCaps: caps, labelsUnreadable: false }).level;

  it("keeps the level when no capped label is present", () => {
    expect(level("L3", ["feature"])).toBe("L3");
  });

  it("caps a Run with an SDD section 28 label at L2 when the Product sets no caps", () => {
    expect(level("L3", ["payments"])).toBe("L2");
  });

  it("follows the caps of the Product, so an operator can trust a label fully", () => {
    expect(level("L3", ["payments", "database-migration"], { payments: "L2" })).toBe("L2");
    expect(level("L3", ["database-migration"], { payments: "L2" })).toBe("L3");
  });

  it("lowers the level with a factoree label, and never raises it", () => {
    expect(level("L3", ["factoree:l1"])).toBe("L1");
    expect(level("L1", ["factoree:l2"])).toBe("L1");
  });

  it("does not raise a level below the cap", () => {
    expect(level("L0", ["payments"])).toBe("L0");
  });

  it("caps L4 to L3, because Version 1 must not merge automatically", () => {
    expect(level("L4", [])).toBe("L3");
  });

  it("falls back to L2 for an unknown level", () => {
    expect(level("L9", [])).toBe("L2");
  });

  it("runs at L2 when the labels could not be read, because the cap must fail closed", () => {
    const decision = decideAutonomy({ defaultLevel: "L3", labels: [], riskCaps: null, labelsUnreadable: true });
    expect(decision.level).toBe("L2");
    expect(decision.reasons.join(" ")).toMatch(/could not read the labels/);
  });

  it("names the reason for every cap it applied", () => {
    const decision = decideAutonomy({
      defaultLevel: "L3",
      labels: ["Payments", "factoree:l1"],
      riskCaps: null,
      labelsUnreadable: false,
    });
    expect(decision.level).toBe("L1");
    expect(decision.reasons).toEqual([
      'The label "payments" caps this Run at L2.',
      'The label "factoree:l1" lowers this Run to L1.',
    ]);
  });
});
