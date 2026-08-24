import { describe, expect, it } from "vitest";
import type { ValidationAssertion } from "~/domain/validation/validation-contract.js";
import type { HttpPlanRequest } from "~/domain/validation/validation-plan.js";
import {
  executeHttpAssertion,
  SENSITIVE_HEADERS,
  type ExecuteHttpAssertionInput,
} from "~/domain/validation/http-validation.js";
import { Redactor } from "~/telemetry/redaction.js";

const assertion: ValidationAssertion = {
  id: "VAL-API-001",
  requirement: "AC-2",
  statement: "PATCH /projects/{id} returns 403 for a user without edit permission.",
  method: "http",
  evidence: ["request-response"],
  preconditions: [],
};

const baseRequest: HttpPlanRequest = {
  method: "PATCH",
  path: "/projects/1",
  headers: {},
  body: '{"name":"x"}',
  expectStatus: 403,
  expectBodyContains: null,
};

const baseInput: ExecuteHttpAssertionInput = {
  assertion,
  request: baseRequest,
  baseUrl: "http://preview.invalid:8080",
  fetchImpl: () =>
    Promise.resolve({
      status: 403,
      headers: { "content-type": "application/json" },
      body: '{"error":"forbidden"}',
    }),
  redactor: new Redactor(),
};

describe("executeHttpAssertion", () => {
  it("records the method, the path, the status, and the result", async () => {
    const outcome = await executeHttpAssertion(baseInput);

    expect(outcome.result).toBe("PASS");
    expect(outcome.assertionId).toBe("VAL-API-001");
    expect(outcome.method).toBe("http");
    expect(outcome.artifacts).toHaveLength(1);
    const artifact = outcome.artifacts[0]!;
    expect(artifact.kind).toBe("request-response");
    expect(artifact.source).toBe("http:VAL-API-001");
    expect(artifact.contentType).toBe("application/json");
    expect(artifact.metadata).toMatchObject({
      method: "PATCH",
      path: "/projects/1",
      status: 403,
      expectStatus: 403,
      passed: true,
    });
    // bytes must be the UTF-8 encoding of the canonical JSON of the metadata
    const decoded: unknown = JSON.parse(new TextDecoder().decode(artifact.bytes));
    expect(decoded).toEqual(artifact.metadata);
  });

  it("redacts a sensitive header and a Project secret", async () => {
    const outcome = await executeHttpAssertion({
      assertion,
      request: {
        method: "GET",
        path: "/me",
        headers: { Authorization: "Bearer abc123xyz" },
        body: null,
        expectStatus: 200,
        expectBodyContains: null,
      },
      baseUrl: "http://preview.invalid:8080",
      fetchImpl: () => Promise.resolve({ status: 200, headers: {}, body: "token super-secret-value" }),
      redactor: new Redactor(["super-secret-value"]),
    });

    const text = JSON.stringify(outcome.artifacts[0]!.metadata);
    expect(text).not.toContain("abc123xyz");
    expect(text).not.toContain("super-secret-value");
    expect(text).toContain("[redacted]");
    expect(text).toContain("authorization");
  });

  it("lists the frozen sensitive header names", () => {
    expect(SENSITIVE_HEADERS).toEqual([
      "authorization",
      "proxy-authorization",
      "cookie",
      "set-cookie",
      "x-api-key",
    ]);
  });

  it("fails when the status differs from the expected status", async () => {
    const outcome = await executeHttpAssertion({
      ...baseInput,
      fetchImpl: () => Promise.resolve({ status: 200, headers: {}, body: "" }),
    });

    expect(outcome.result).toBe("FAIL");
    expect(outcome.reason).toContain("403");
    expect(outcome.reason).toContain("200");
  });

  it("fails when the expected body text is absent", async () => {
    const outcome = await executeHttpAssertion({
      ...baseInput,
      request: { ...baseRequest, expectStatus: 200, expectBodyContains: "forbidden" },
      fetchImpl: () => Promise.resolve({ status: 200, headers: {}, body: "{}" }),
    });

    expect(outcome.result).toBe("FAIL");
    expect(outcome.reason).toContain("forbidden");
  });

  it("blocks when the transport throws", async () => {
    const outcome = await executeHttpAssertion({
      ...baseInput,
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });

    expect(outcome.result).toBe("BLOCKED");
    expect(outcome.reason).toContain("ECONNREFUSED");
    expect(outcome.artifacts).toHaveLength(1);
  });

  it("blocks and redacts a secret carried in the transport error message", async () => {
    const outcome = await executeHttpAssertion({
      ...baseInput,
      redactor: new Redactor(["super-secret-value"]),
      fetchImpl: () => Promise.reject(new Error("connection failed with token super-secret-value")),
    });

    expect(outcome.result).toBe("BLOCKED");
    expect(outcome.reason).not.toContain("super-secret-value");
  });

  it("truncates a long body and records that it did", async () => {
    const longBody = "x".repeat(20000);
    const outcome = await executeHttpAssertion({
      ...baseInput,
      fetchImpl: () => Promise.resolve({ status: 403, headers: {}, body: longBody }),
    });

    const metadata = outcome.artifacts[0]!.metadata as {
      response: { body: string; bodyTruncated: boolean; bodyLength: number };
    };
    expect(metadata.response.bodyTruncated).toBe(true);
    expect(metadata.response.bodyLength).toBe(20000);
    expect(metadata.response.body.length).toBeLessThanOrEqual(8192);
  });

  it("matches expectBodyContains past the truncation cut", async () => {
    // The needle sits after character 8192. Truncation is a storage rule, so a correct
    // implementation must not be sent into the SDD section 42 repair budget.
    const needle = "the-late-marker";
    const longBody = `${"x".repeat(10000)}${needle}${"y".repeat(100)}`;
    const outcome = await executeHttpAssertion({
      ...baseInput,
      request: { ...baseRequest, expectBodyContains: needle },
      fetchImpl: () => Promise.resolve({ status: 403, headers: {}, body: longBody }),
    });

    expect(outcome.result).toBe("PASS");
    const metadata = outcome.artifacts[0]!.metadata as {
      response: { body: string; bodyTruncated: boolean };
    };
    // The stored body stays truncated, so the evidence stays a record.
    expect(metadata.response.bodyTruncated).toBe(true);
    expect(metadata.response.body).not.toContain(needle);
  });

  it("never matches expectBodyContains against an unredacted body", async () => {
    const outcome = await executeHttpAssertion({
      ...baseInput,
      redactor: new Redactor(["super-secret-value"]),
      request: { ...baseRequest, expectBodyContains: "super-secret-value" },
      fetchImpl: () => Promise.resolve({ status: 403, headers: {}, body: "token super-secret-value" }),
    });

    expect(outcome.result).toBe("FAIL");
  });
});
