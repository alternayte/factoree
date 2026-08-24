import { describe, expect, it } from "vitest";
import {
  hashValidationContract,
  renderValidationContract,
  validateValidationContract,
  ValidationContractInvalidError,
  type ValidationAssertion,
  type ValidationContract,
} from "~/domain/validation/validation-contract.js";

const assertion = (overrides: Partial<ValidationAssertion> = {}): ValidationAssertion => ({
  id: "VAL-API-001",
  requirement: "AC-1",
  statement: "PATCH /projects/{id} returns 403 for a user without edit permission.",
  method: "http",
  evidence: ["request-response"],
  preconditions: [],
  ...overrides,
});

const contract = (overrides: Partial<ValidationContract> = {}): ValidationContract => ({
  version: 1,
  runId: "run-1",
  workItem: "ENG-143",
  goal: "Deny an edit to a user without permission.",
  assertions: [assertion()],
  ...overrides,
});

describe("validateValidationContract", () => {
  it("accepts a contract whose assertion carries every required field", () => {
    expect(() => validateValidationContract(contract())).not.toThrow();
  });

  it("rejects a contract with no assertion, because SDD section 9 requires one", () => {
    expect(() => validateValidationContract(contract({ assertions: [] }))).toThrow(
      ValidationContractInvalidError,
    );
  });

  it("rejects a duplicate assertion identifier", () => {
    const contractValue = contract({ assertions: [assertion(), assertion()] });
    expect(() => validateValidationContract(contractValue)).toThrow(/appears twice/);
  });

  it("rejects an assertion with no source requirement", () => {
    const contractValue = contract({ assertions: [assertion({ requirement: "  " })] });
    expect(() => validateValidationContract(contractValue)).toThrow(/source requirement/);
  });

  it("rejects an assertion with no observable statement", () => {
    const contractValue = contract({ assertions: [assertion({ statement: "" })] });
    expect(() => validateValidationContract(contractValue)).toThrow(/observable behavior/);
  });

  it("rejects an unknown method", () => {
    const contractValue = contract({
      assertions: [assertion({ method: "telepathy" as ValidationAssertion["method"] })],
    });
    expect(() => validateValidationContract(contractValue)).toThrow(/method/);
  });

  it("rejects an assertion that requires no evidence", () => {
    const contractValue = contract({ assertions: [assertion({ evidence: [] })] });
    expect(() => validateValidationContract(contractValue)).toThrow(/evidence/);
  });

  it("rejects an unknown evidence kind", () => {
    const contractValue = contract({
      assertions: [
        assertion({ evidence: ["vibes" as ValidationAssertion["evidence"][number]] }),
      ],
    });
    expect(() => validateValidationContract(contractValue)).toThrow(/evidence/);
  });

  it("rejects a contract with no goal", () => {
    expect(() => validateValidationContract(contract({ goal: " " }))).toThrow(/goal/);
  });
});

describe("hashValidationContract", () => {
  it("gives one contract one hash, whatever the key order was", () => {
    const left = hashValidationContract(contract());
    const right = hashValidationContract(
      JSON.parse(
        JSON.stringify({
          assertions: contract().assertions,
          goal: contract().goal,
          runId: "run-1",
          version: 1,
          workItem: "ENG-143",
        }),
      ) as ValidationContract,
    );
    expect(left).toBe(right);
  });

  it("changes when an assertion changes", () => {
    const weakened = contract({ assertions: [assertion({ evidence: ["human-confirmation"] })] });
    expect(hashValidationContract(weakened)).not.toBe(hashValidationContract(contract()));
  });

  it("is a SHA-256 hexadecimal digest", () => {
    expect(hashValidationContract(contract())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("renderValidationContract", () => {
  it("names the Work Item, every assertion identifier, its method, and its evidence", () => {
    const document = renderValidationContract(contract());
    expect(document).toContain("ENG-143");
    expect(document).toContain("VAL-API-001");
    expect(document).toContain("AC-1");
    expect(document).toContain("http");
    expect(document).toContain("request-response");
  });

  it("states the immutability rule of SDD section 25", () => {
    expect(renderValidationContract(contract())).toContain("must not");
  });
});
