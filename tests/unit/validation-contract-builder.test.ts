import { describe, expect, it } from "vitest";
import {
  buildValidationContract,
  methodFor,
  type BuildValidationContractInput,
} from "~/domain/validation/validation-contract-builder.js";
import { validateValidationContract } from "~/domain/validation/validation-contract.js";

const input = (overrides: Partial<BuildValidationContractInput> = {}): BuildValidationContractInput => ({
  runId: "run-1",
  workItem: "ENG-143",
  goal: "A signed-in editor can rename a project.",
  acceptanceCriteria: [
    { id: "AC-1", statement: "A signed-in editor can change the project name and the new name remains visible after reload.", source: "work-item" },
    { id: "AC-2", statement: "PATCH /projects/{id} returns 403 for a user without edit permission.", source: "work-item" },
  ],
  humanAssertions: [],
  ...overrides,
});

describe("methodFor", () => {
  it("chooses http for a statement that names an HTTP method and a path", () => {
    expect(methodFor("PATCH /projects/{id} returns 403 for a user without edit permission.")).toBe("http");
  });

  it("chooses browser for a statement about a page a person uses", () => {
    expect(methodFor("A signed-in editor can click Save and the new name remains visible after reload.")).toBe("browser");
  });

  it("chooses test for a statement about the test suite", () => {
    expect(methodFor("The unit tests for the rename service pass.")).toBe("test");
  });

  it("chooses command for a statement about a command and its exit code", () => {
    expect(methodFor("The command npm run build exits with code 0.")).toBe("command");
  });

  it("chooses code_review for a statement about a review of the source", () => {
    expect(methodFor("A code review confirms that no production file imports the fixture module.")).toBe("code_review");
  });

  it("chooses manual when no rule matches, because Factoree must not claim an automated proof", () => {
    expect(methodFor("The product feels faster.")).toBe("manual");
  });

  it("prefers http over browser when the statement names both", () => {
    expect(methodFor("The page calls POST /projects and shows the result.")).toBe("http");
  });

  it("chooses browser when a weak HTTP word and a browser word appear together", () => {
    expect(
      methodFor("The user clicks Save, the page reloads, and the server returns 200."),
    ).toBe("browser");
  });

  it("chooses http for weak HTTP words alone, with no browser word", () => {
    expect(methodFor("The health endpoint returns 200.")).toBe("http");
  });

  it("chooses http when an explicit HTTP call and a browser word appear together", () => {
    expect(methodFor("The page calls POST /projects and shows the result.")).toBe("http");
  });
});

describe("buildValidationContract", () => {
  it("produces one assertion for each acceptance criterion, and records the criterion identifier", () => {
    const built = buildValidationContract(input());
    expect(built.contract.assertions).toHaveLength(2);
    expect(built.contract.assertions.map((assertion) => assertion.requirement)).toEqual(["AC-1", "AC-2"]);
  });

  it("names each assertion by its method, and numbers it inside that method", () => {
    const built = buildValidationContract(input());
    expect(built.contract.assertions[0]?.id).toBe("VAL-UI-001");
    expect(built.contract.assertions[1]?.id).toBe("VAL-API-001");
  });

  it("requires the SDD section 37 browser evidence for a browser assertion", () => {
    const built = buildValidationContract(input());
    expect(built.contract.assertions[0]?.evidence).toEqual(["screenshot", "network", "assertion-log"]);
  });

  it("requires the SDD section 38 request and response evidence for an HTTP assertion", () => {
    const built = buildValidationContract(input());
    expect(built.contract.assertions[1]?.evidence).toEqual(["request-response"]);
  });

  it("reads a leading Given clause as a permitted precondition", () => {
    const built = buildValidationContract(
      input({
        acceptanceCriteria: [
          { id: "AC-1", statement: "Given a project named Old, the editor can rename it on the project page.", source: "work-item" },
        ],
      }),
    );
    expect(built.contract.assertions[0]?.preconditions).toEqual(["a project named Old"]);
    expect(built.contract.assertions[0]?.statement).toBe("the editor can rename it on the project page.");
  });

  it("turns a recorded human answer into an assertion of its own", () => {
    const built = buildValidationContract(
      input({ acceptanceCriteria: [], humanAssertions: ["The rename button is disabled for a viewer."] }),
    );
    expect(built.contract.assertions).toHaveLength(1);
    expect(built.contract.assertions[0]?.requirement).toBe("AC-H1");
  });

  it("produces no assertion when nothing observable was stated", () => {
    const built = buildValidationContract(input({ acceptanceCriteria: [], humanAssertions: [] }));
    expect(built.contract.assertions).toEqual([]);
  });

  it("produces a valid contract, its hash, and its document when at least one assertion exists", () => {
    const built = buildValidationContract(input());
    expect(() => validateValidationContract(built.contract)).not.toThrow();
    expect(built.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(built.document).toContain("VAL-UI-001");
  });

  it("is deterministic, so the same input always freezes to the same hash", () => {
    expect(buildValidationContract(input()).sha256).toBe(buildValidationContract(input()).sha256);
  });

  it("skips a criterion whose statement is empty", () => {
    const built = buildValidationContract(
      input({ acceptanceCriteria: [{ id: "AC-1", statement: "   ", source: "work-item" }], humanAssertions: [] }),
    );
    expect(built.contract.assertions).toEqual([]);
  });
});
