import { describe, expect, it } from "vitest";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import {
  parseValidationPlan,
  planKindForMethod,
  ValidationPlanInvalidError,
} from "~/domain/validation/validation-plan.js";
import {
  summarizeUserValidation,
  type AssertionOutcome,
} from "~/domain/validation/validation-result.js";

const contract: ValidationContract = {
  version: 1,
  runId: "run-1",
  workItem: "ENG-143",
  goal: "Let an editor rename a project.",
  assertions: [
    {
      id: "VAL-UI-001",
      requirement: "AC-1",
      statement: "The new name stays visible after reload.",
      method: "browser",
      evidence: ["screenshot", "assertion-log"],
      preconditions: [],
    },
    {
      id: "VAL-API-001",
      requirement: "AC-2",
      statement: "PATCH /projects/{id} returns 403.",
      method: "http",
      evidence: ["request-response"],
      preconditions: [],
    },
    {
      id: "VAL-MAN-001",
      requirement: "AC-3",
      statement: "A designer confirms the spacing.",
      method: "manual",
      evidence: ["human-confirmation"],
      preconditions: [],
    },
  ],
};

const validBrowserSteps = [
  { action: "goto" as const, path: "/projects/1" },
  { action: "fill" as const, selector: "#name", value: "Renamed" },
  { action: "click" as const, selector: "#save" },
  { action: "reload" as const },
  { action: "expectText" as const, selector: "#name", text: "Renamed" },
  { action: "screenshot" as const, name: "after-reload" },
];

const validHttpRequest = {
  method: "PATCH" as const,
  path: "/projects/1",
  headers: {},
  body: "{}",
  expectStatus: 403,
  expectBodyContains: null,
};

describe("planKindForMethod", () => {
  it("maps each frozen method to its plan entry kind", () => {
    expect(planKindForMethod("http")).toBe("http");
    expect(planKindForMethod("browser")).toBe("browser");
    expect(planKindForMethod("command")).toBe("command");
    expect(planKindForMethod("test")).toBe("command");
    expect(planKindForMethod("code_review")).toBeNull();
    expect(planKindForMethod("manual")).toBeNull();
  });
});

describe("parseValidationPlan", () => {
  it("accepts a plan that covers the automated assertions", () => {
    const plan = parseValidationPlan(
      JSON.stringify({
        version: 1,
        entries: [
          { assertionId: "VAL-UI-001", kind: "browser", steps: validBrowserSteps },
          { assertionId: "VAL-API-001", kind: "http", request: validHttpRequest },
        ],
      }),
      contract,
    );

    expect(plan.entries).toHaveLength(2);
    expect(plan.version).toBe(1);
  });

  it("rejects text that is not JSON (rule 1)", () => {
    expect(() => parseValidationPlan("not json", contract)).toThrow(ValidationPlanInvalidError);
  });

  it("rejects a document that fails the strict schema, for example a wrong version (rule 2)", () => {
    expect(() =>
      parseValidationPlan(JSON.stringify({ version: 2, entries: [] }), contract),
    ).toThrow(ValidationPlanInvalidError);
  });

  it("rejects an unknown key (rule 2)", () => {
    expect(() =>
      parseValidationPlan(
        JSON.stringify({
          version: 1,
          entries: [
            {
              assertionId: "VAL-UI-001",
              kind: "browser",
              steps: validBrowserSteps,
              comment: "hi",
            },
          ],
        }),
        contract,
      ),
    ).toThrow(ValidationPlanInvalidError);
  });

  it("rejects a plan entry for an unknown assertion (rule 3)", () => {
    expect(() =>
      parseValidationPlan(
        JSON.stringify({
          version: 1,
          entries: [
            {
              assertionId: "VAL-UI-999",
              kind: "browser",
              steps: [
                { action: "goto", path: "/" },
                { action: "expectVisible", selector: "#x" },
              ],
            },
          ],
        }),
        contract,
      ),
    ).toThrow(/VAL-UI-999/);
  });

  it("rejects a duplicate assertion identifier (rule 4)", () => {
    expect(() =>
      parseValidationPlan(
        JSON.stringify({
          version: 1,
          entries: [
            { assertionId: "VAL-API-001", kind: "http", request: validHttpRequest },
            { assertionId: "VAL-API-001", kind: "http", request: validHttpRequest },
          ],
        }),
        contract,
      ),
    ).toThrow(/VAL-API-001/);
  });

  it("rejects an entry whose kind contradicts the frozen method (rule 5)", () => {
    expect(() =>
      parseValidationPlan(
        JSON.stringify({
          version: 1,
          entries: [{ assertionId: "VAL-UI-001", kind: "http", request: validHttpRequest }],
        }),
        contract,
      ),
    ).toThrow(/VAL-UI-001/);
  });

  it("rejects an entry for a manual assertion (rule 6)", () => {
    expect(() =>
      parseValidationPlan(
        JSON.stringify({
          version: 1,
          entries: [
            {
              assertionId: "VAL-MAN-001",
              kind: "command",
              command: { run: "echo hi", expectExitCode: 0 },
            },
          ],
        }),
        contract,
      ),
    ).toThrow(/VAL-MAN-001/);
  });

  it("rejects a browser scenario that asserts nothing (rule 7)", () => {
    expect(() =>
      parseValidationPlan(
        JSON.stringify({
          version: 1,
          entries: [
            {
              assertionId: "VAL-UI-001",
              kind: "browser",
              steps: [
                { action: "goto", path: "/projects/1" },
                { action: "click", selector: "#save" },
              ],
            },
          ],
        }),
        contract,
      ),
    ).toThrow(/VAL-UI-001/);
  });

  it("rejects a browser entry with no steps (rule 7)", () => {
    expect(() =>
      parseValidationPlan(
        JSON.stringify({
          version: 1,
          entries: [{ assertionId: "VAL-UI-001", kind: "browser", steps: [] }],
        }),
        contract,
      ),
    ).toThrow(/VAL-UI-001/);
  });

  it("rejects a browser entry with no goto step (rule 8)", () => {
    expect(() =>
      parseValidationPlan(
        JSON.stringify({
          version: 1,
          entries: [
            {
              assertionId: "VAL-UI-001",
              kind: "browser",
              steps: [{ action: "expectVisible", selector: "#x" }],
            },
          ],
        }),
        contract,
      ),
    ).toThrow(/VAL-UI-001/);
  });

  it("rejects a browser entry whose first step is not goto (rule 8)", () => {
    expect(() =>
      parseValidationPlan(
        JSON.stringify({
          version: 1,
          entries: [
            {
              assertionId: "VAL-UI-001",
              kind: "browser",
              steps: [
                { action: "expectVisible", selector: "#x" },
                { action: "goto", path: "/" },
              ],
            },
          ],
        }),
        contract,
      ),
    ).toThrow(/VAL-UI-001/);
  });

  describe("network control steps (browser-network-control.md)", () => {
    const browserPlan = (steps: unknown[]): string =>
      JSON.stringify({ version: 1, entries: [{ assertionId: "VAL-UI-001", kind: "browser", steps }] });
    const reasonsOf = (steps: unknown[]): string[] => {
      try {
        parseValidationPlan(browserPlan(steps), contract);
      } catch (error) {
        if (error instanceof ValidationPlanInvalidError) return error.reasons;
        throw error;
      }
      return [];
    };

    it("accepts a checked hold, a release and a failed request on any host", () => {
      expect(
        reasonsOf([
          { action: "holdRequest", url: "**/graphql" },
          { action: "failRequest", url: "https://api.example.com/v1/**", status: 500 },
          { action: "failRequest", url: "**/api/other", status: "network" },
          { action: "goto", path: "/configs" },
          { action: "expectText", selector: "main", text: "Loading configs..." },
          { action: "screenshot", name: "loading" },
          { action: "releaseRequests" },
          { action: "expectVisible", selector: "table" },
        ]),
      ).toEqual([]);
    });

    it("rejects a hold that no check follows before its release", () => {
      const reasons = reasonsOf([
        { action: "goto", path: "/" },
        { action: "holdRequest", url: "**/api/configs" },
        { action: "click", selector: "#load" },
        { action: "releaseRequests" },
        { action: "expectVisible", selector: "table" },
      ]);
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toMatch(/holds "\*\*\/api\/configs" at step 2, but no expectText/);
    });

    it("rejects a hold that no check follows before the scenario ends", () => {
      const reasons = reasonsOf([
        { action: "goto", path: "/" },
        { action: "expectVisible", selector: "table" },
        { action: "holdRequest", url: "**/api/configs" },
      ]);
      expect(reasons.some((reason) => reason.includes("A hold that checks nothing proves nothing."))).toBe(true);
    });

    it.each(["^https://api\\.example\\.com/.*$", "/api/(configs|users)/", ".*graphql", "/api/configs"])(
      "rejects the request pattern %s, which is no URL glob",
      (url) => {
        const reasons = reasonsOf([
          { action: "goto", path: "/" },
          { action: "failRequest", url, status: 500 },
          { action: "expectVisible", selector: "#error" },
        ]);
        expect(reasons).toHaveLength(1);
        expect(reasons[0]).toContain(`failRequest url "${url}"`);
      },
    );

    it("rejects a failRequest status that is no HTTP error", () => {
      expect(
        reasonsOf([
          { action: "goto", path: "/" },
          { action: "failRequest", url: "**/api", status: 200 },
          { action: "expectVisible", selector: "#error" },
        ])[0],
      ).toMatch(/plan schema/);
    });
  });

  it("rejects an http entry whose path does not begin with a slash (rule 9)", () => {
    expect(() =>
      parseValidationPlan(
        JSON.stringify({
          version: 1,
          entries: [
            {
              assertionId: "VAL-API-001",
              kind: "http",
              request: { ...validHttpRequest, path: "projects/1" },
            },
          ],
        }),
        contract,
      ),
    ).toThrow(/VAL-API-001/);
  });

  it.each(["//example.com", "///example.com", "/\\example.com", "\\/example.com"])(
    "rejects an http entry whose path %s can leave the preview origin",
    (path) => {
      expect(() =>
        parseValidationPlan(
          JSON.stringify({
            version: 1,
            entries: [
              {
                assertionId: "VAL-API-001",
                kind: "http",
                request: { ...validHttpRequest, path },
              },
            ],
          }),
          contract,
        ),
      ).toThrow(ValidationPlanInvalidError);
    },
  );

  it.each(["//example.com", "///example.com", "/\\example.com", "\\/example.com"])(
    "rejects a browser goto path %s that can leave the preview origin",
    (path) => {
      expect(() =>
        parseValidationPlan(
          JSON.stringify({
            version: 1,
            entries: [
              {
                assertionId: "VAL-UI-001",
                kind: "browser",
                steps: [{ action: "goto", path }, ...validBrowserSteps.slice(1)],
              },
            ],
          }),
          contract,
        ),
      ).toThrow(ValidationPlanInvalidError);
    },
  );

  it.each(["/\t/example.com", "/\n/example.com", "/\r/example.com"])(
    // The WHATWG URL parser strips an ASCII tab, a line feed, and a carriage return from
    // anywhere in the input before it parses the input, so %j resolves to a foreign origin at
    // execution even though neither character sits at path[1]. The parser must reject the plan
    // at freeze time, before a whole Run is spent to reach the same refusal at execution.
    "rejects an http entry whose path %j can leave the preview origin",
    (path) => {
      expect(() =>
        parseValidationPlan(
          JSON.stringify({
            version: 1,
            entries: [
              {
                assertionId: "VAL-API-001",
                kind: "http",
                request: { ...validHttpRequest, path },
              },
            ],
          }),
          contract,
        ),
      ).toThrow(ValidationPlanInvalidError);
    },
  );

  it.each(["/\t/example.com", "/\n/example.com", "/\r/example.com"])(
    "rejects a browser goto path %j that can leave the preview origin",
    (path) => {
      expect(() =>
        parseValidationPlan(
          JSON.stringify({
            version: 1,
            entries: [
              {
                assertionId: "VAL-UI-001",
                kind: "browser",
                steps: [{ action: "goto", path }, ...validBrowserSteps.slice(1)],
              },
            ],
          }),
          contract,
        ),
      ).toThrow(ValidationPlanInvalidError);
    },
  );

  it("accepts a bare slash as an http path and as a goto path", () => {
    const plan = parseValidationPlan(
      JSON.stringify({
        version: 1,
        entries: [
          {
            assertionId: "VAL-UI-001",
            kind: "browser",
            steps: [{ action: "goto", path: "/" }, ...validBrowserSteps.slice(1)],
          },
          {
            assertionId: "VAL-API-001",
            kind: "http",
            request: { ...validHttpRequest, path: "/" },
          },
        ],
      }),
      contract,
    );

    expect(plan.entries).toHaveLength(2);
  });

  it("does not require every assertion to have an entry (rule 10)", () => {
    const plan = parseValidationPlan(
      JSON.stringify({
        version: 1,
        entries: [{ assertionId: "VAL-API-001", kind: "http", request: validHttpRequest }],
      }),
      contract,
    );

    expect(plan.entries).toHaveLength(1);
  });
});

describe("summarizeUserValidation", () => {
  const pass = (assertionId: string): AssertionOutcome => ({
    assertionId,
    method: "http",
    result: "PASS",
    reason: `${assertionId} passed.`,
    artifacts: [],
  });

  const manual = (assertionId: string): AssertionOutcome => ({
    assertionId,
    method: "manual",
    result: "MANUAL_REQUIRED",
    reason: `${assertionId} needs a human.`,
    artifacts: [],
  });

  const fail = (assertionId: string): AssertionOutcome => ({
    assertionId,
    method: "http",
    result: "FAIL",
    reason: `${assertionId} failed.`,
    artifacts: [],
  });

  it("passes only when every assertion is PASS", () => {
    expect(summarizeUserValidation([pass("A"), pass("B")]).passed).toBe(true);
    expect(summarizeUserValidation([pass("A"), manual("B")]).passed).toBe(false);
    expect(summarizeUserValidation([]).passed).toBe(false);
  });

  it("lists the failing assertions in failures", () => {
    const outcome = summarizeUserValidation([pass("A"), fail("B"), manual("C")]);
    expect(outcome.failures).toHaveLength(2);
    expect(outcome.failures.some((line) => line.includes("B"))).toBe(true);
    expect(outcome.failures.some((line) => line.includes("C"))).toBe(true);
  });

  it("produces a readable summary", () => {
    const outcome = summarizeUserValidation([pass("A")]);
    expect(outcome.summary.length).toBeGreaterThan(0);
  });
});
