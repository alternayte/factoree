import type { AssertionOutcome, EvidenceArtifact } from "~/domain/validation/validation-result.js";
import type { ValidationAssertion } from "~/domain/validation/validation-contract.js";
import type { HttpPlanRequest } from "~/domain/validation/validation-plan.js";
import type { Redactor } from "~/telemetry/redaction.js";

/** SDD section 38. What one HTTP transport call returned. */
export interface HttpValidationResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The injected transport. The domain module must not import `node:http` or a provider client. */
export type HttpValidationFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string | null },
) => Promise<HttpValidationResponse>;

export interface ExecuteHttpAssertionInput {
  assertion: ValidationAssertion;
  request: HttpPlanRequest;
  /** The exposed preview URL. SDD section 37 step 3. */
  baseUrl: string;
  fetchImpl: HttpValidationFetch;
  redactor: Redactor;
}

/** The header names that never reach persistence. SDD section 38 and section 60. */
export const SENSITIVE_HEADERS: readonly string[] = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
];

const SENSITIVE_HEADER_SET = new Set(SENSITIVE_HEADERS);

const REDACTED_VALUE = "[redacted]";

const MAX_BODY_LENGTH = 8192;

interface SanitizedBody {
  body: string;
  bodyTruncated: boolean;
  bodyLength: number;
}

/** Flattens a sanitized body into the metadata shape the reader expects. */
const bodyMetadata = (sanitized: SanitizedBody | null): { body: string | null } | SanitizedBody =>
  sanitized === null ? { body: null } : sanitized;

/**
 * Redacts every header value. A sensitive header keeps its name but never its real value, so the
 * reader can see that the header was present. Every other header passes through the redactor.
 */
const sanitizeHeaders = (
  headers: Record<string, string>,
  redactor: Redactor,
): Record<string, string> => {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    // The header name is recorded lower case, so the reader can find a sensitive header by its
    // name from SENSITIVE_HEADERS without a case-sensitive search.
    const lowerName = name.toLowerCase();
    output[lowerName] = SENSITIVE_HEADER_SET.has(lowerName)
      ? REDACTED_VALUE
      : redactor.redactText(value);
  }
  return output;
};

/** Redacts a body. A secret never reaches an evidence record, and never reaches a match. */
const redactBody = (body: string | null, redactor: Redactor): string | null =>
  body === null ? null : redactor.redactText(body);

/**
 * Truncates an already redacted body for storage. Evidence must stay a record, not a data dump.
 * The caller matches `expectBodyContains` against the untruncated redacted body, so a substring
 * past the cut still passes.
 */
const truncateBody = (redacted: string | null): SanitizedBody | null => {
  if (redacted === null) return null;
  const bodyLength = redacted.length;
  const bodyTruncated = bodyLength > MAX_BODY_LENGTH;
  return {
    body: bodyTruncated ? redacted.slice(0, MAX_BODY_LENGTH) : redacted,
    bodyTruncated,
    bodyLength,
  };
};

/** Sorts object keys, so the same metadata always produces the same bytes. */
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
};

const artifactBytes = (metadata: Record<string, unknown>): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(canonicalize(metadata)));

const buildArtifact = (
  assertionId: string,
  metadata: Record<string, unknown>,
): EvidenceArtifact => ({
  kind: "request-response",
  source: `http:${assertionId}`,
  contentType: "application/json",
  bytes: artifactBytes(metadata),
  metadata,
});

/**
 * Executes one HTTP assertion against the exposed preview and turns the result into an
 * AssertionOutcome with one sanitized evidence artefact. SDD section 38.
 */
export const executeHttpAssertion = async (
  input: ExecuteHttpAssertionInput,
): Promise<AssertionOutcome> => {
  const { assertion, request, baseUrl, fetchImpl, redactor } = input;
  const url = new URL(request.path, baseUrl).toString();
  const sanitizedRequestHeaders = sanitizeHeaders(request.headers, redactor);
  const sanitizedRequestBody = truncateBody(redactBody(request.body, redactor));

  let response: HttpValidationResponse;
  try {
    response = await fetchImpl(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const redactedMessage = redactor.redactText(message);
    const metadata = {
      method: request.method,
      path: request.path,
      expectStatus: request.expectStatus,
      expectBodyContains: request.expectBodyContains,
      request: {
        headers: sanitizedRequestHeaders,
        ...bodyMetadata(sanitizedRequestBody),
      },
      error: redactedMessage,
      passed: false,
    };
    return {
      assertionId: assertion.id,
      method: assertion.method,
      result: "BLOCKED",
      reason: `The HTTP transport call to "${request.method} ${request.path}" failed: ${redactedMessage}`,
      artifacts: [buildArtifact(assertion.id, metadata)],
    };
  }

  const sanitizedResponseHeaders = sanitizeHeaders(response.headers, redactor);
  const redactedResponseBody = redactBody(response.body, redactor);
  const sanitizedResponseBody = truncateBody(redactedResponseBody);

  const statusMatches = response.status === request.expectStatus;
  // The match reads the untruncated redacted body. Truncation is a storage rule, and it must
  // never turn a correct implementation into a FAIL.
  const bodyMatches =
    request.expectBodyContains === null ||
    (redactedResponseBody !== null && redactedResponseBody.includes(request.expectBodyContains));
  const passed = statusMatches && bodyMatches;

  const metadata = {
    method: request.method,
    path: request.path,
    status: response.status,
    expectStatus: request.expectStatus,
    expectBodyContains: request.expectBodyContains,
    passed,
    request: {
      headers: sanitizedRequestHeaders,
      ...bodyMetadata(sanitizedRequestBody),
    },
    response: {
      headers: sanitizedResponseHeaders,
      ...bodyMetadata(sanitizedResponseBody),
    },
  };

  const artifact = buildArtifact(assertion.id, metadata);

  if (passed) {
    return {
      assertionId: assertion.id,
      method: assertion.method,
      result: "PASS",
      reason: `${request.method} ${request.path} returned the expected status ${String(request.expectStatus)}.`,
      artifacts: [artifact],
    };
  }

  const reason = !statusMatches
    ? `${request.method} ${request.path} expected status ${String(request.expectStatus)} but observed ${String(response.status)}.`
    : `${request.method} ${request.path} expected the response body to hold "${String(request.expectBodyContains)}", which was absent.`;

  return {
    assertionId: assertion.id,
    method: assertion.method,
    result: "FAIL",
    reason,
    artifacts: [artifact],
  };
};
