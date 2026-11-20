import type { AssertionOutcome, EvidenceArtifact } from "~/domain/validation/validation-result.js";
import type { ValidationAssertion } from "~/domain/validation/validation-contract.js";
import type { HttpPlanRequest, HttpPoll } from "~/domain/validation/validation-plan.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { resolvePreviewUrl } from "~/domain/validation/preview-url.js";

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
  /** docs/specs/check-faults.md. The setup requests, sent in order before the check. */
  setup?: readonly HttpPlanRequest[] | undefined;
  /** docs/specs/check-faults.md. Sends the check again until it matches or the timeout ends. */
  poll?: HttpPoll | undefined;
  /** A test passes a sleep that returns at once and a clock it moves. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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

/** The outcome of a call that never reached a status: a refused path or a transport fault. */
const blocked = (
  assertion: ValidationAssertion,
  request: HttpPlanRequest,
  redactor: Redactor,
  reason: string,
  error: string,
  extra: Record<string, unknown>,
): AssertionOutcome => {
  const metadata = {
    method: request.method,
    path: redactor.redactText(request.path),
    expectStatus: request.expectStatus,
    expectBodyContains: request.expectBodyContains === null ? null : redactor.redactText(request.expectBodyContains),
    request: {
      headers: sanitizeHeaders(request.headers, redactor),
      ...bodyMetadata(truncateBody(redactBody(request.body, redactor))),
    },
    error,
    passed: false,
    ...extra,
  };
  return { assertionId: assertion.id, method: assertion.method, result: "BLOCKED", reason, artifacts: [buildArtifact(assertion.id, metadata)] };
};

type Sent =
  | { kind: "response"; response: HttpValidationResponse }
  | { kind: "refused"; message: string }
  | { kind: "fault"; message: string };

/** Sends one request of the entry. The path check repeats the parser's, because it must not trust it. */
const send = async (request: HttpPlanRequest, baseUrl: string, fetchImpl: HttpValidationFetch, redactor: Redactor): Promise<Sent> => {
  let url: string;
  try {
    url = resolvePreviewUrl(baseUrl, request.path);
  } catch (error) {
    return { kind: "refused", message: redactor.redactText(error instanceof Error ? error.message : String(error)) };
  }
  try {
    return { kind: "response", response: await fetchImpl(url, { method: request.method, headers: request.headers, body: request.body }) };
  } catch (error) {
    return { kind: "fault", message: redactor.redactText(error instanceof Error ? error.message : String(error)) };
  }
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/**
 * Executes one HTTP assertion against the exposed preview and turns the result into an
 * AssertionOutcome with one sanitized evidence artefact. SDD section 38. docs/specs/check-faults.md:
 * the setup requests go first, in order, and the check request may poll.
 */
export const executeHttpAssertion = async (
  input: ExecuteHttpAssertionInput,
): Promise<AssertionOutcome> => {
  const { assertion, request, baseUrl, fetchImpl, redactor } = input;
  const setupRequests = input.setup ?? [];
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  // SDD section 60. The path and the expected body substring come from the agent-authored plan,
  // and that session holds Project test secrets. Redact both before either one reaches a
  // persisted metadata field or a persisted reason. The match below still reads the raw value.
  const redactedPath = redactor.redactText(request.path);
  const redactedExpectBodyContains =
    request.expectBodyContains === null ? null : redactor.redactText(request.expectBodyContains);
  const sanitizedRequestHeaders = sanitizeHeaders(request.headers, redactor);
  const sanitizedRequestBody = truncateBody(redactBody(request.body, redactor));

  // docs/specs/check-faults.md. Each setup request must answer its own status before the check runs.
  const setupRecords: Array<{ method: string; path: string; expectStatus: number; status: number }> = [];
  for (const [index, setup] of setupRequests.entries()) {
    const label = `The setup request ${String(index + 1)}, ${setup.method} ${redactor.redactText(setup.path)},`;
    const sent = await send(setup, baseUrl, fetchImpl, redactor);
    if (sent.kind === "refused") {
      return blocked(assertion, setup, redactor, `Factoree refused the HTTP assertion path: ${sent.message}`, sent.message, { setup: setupRecords });
    }
    if (sent.kind === "fault") {
      return blocked(assertion, setup, redactor, `${label} failed in transport: ${sent.message}`, sent.message, { setup: setupRecords });
    }
    setupRecords.push({ method: setup.method, path: redactor.redactText(setup.path), expectStatus: setup.expectStatus, status: sent.response.status });
    if (sent.response.status !== setup.expectStatus) {
      const metadata = { method: request.method, path: redactedPath, expectStatus: request.expectStatus, expectBodyContains: redactedExpectBodyContains, passed: false, setup: setupRecords };
      return {
        assertionId: assertion.id,
        method: assertion.method,
        result: "FAIL",
        reason: `${label} expected status ${String(setup.expectStatus)} but observed ${String(sent.response.status)}, so the check did not run.`,
        artifacts: [buildArtifact(assertion.id, metadata)],
      };
    }
  }

  const started = now();
  const deadline = input.poll === undefined ? started : started + input.poll.timeoutSeconds * 1000;
  let polls = 0;
  let response: HttpValidationResponse;
  let redactedResponseBody: string | null;
  let statusMatches: boolean;
  let bodyMatches: boolean;
  for (;;) {
    polls += 1;
    const sent = await send(request, baseUrl, fetchImpl, redactor);
    const sequence = setupRequests.length === 0 && input.poll === undefined ? {} : { setup: setupRecords, polls };
    if (sent.kind === "refused") {
      return blocked(assertion, request, redactor, `Factoree refused the HTTP assertion path: ${sent.message}`, sent.message, sequence);
    }
    if (sent.kind === "fault") {
      return blocked(assertion, request, redactor, `The HTTP transport call to "${request.method} ${redactedPath}" failed: ${sent.message}`, sent.message, sequence);
    }
    response = sent.response;
    redactedResponseBody = redactBody(response.body, redactor);
    statusMatches = response.status === request.expectStatus;
    // The match reads the untruncated redacted body. Truncation is a storage rule, and it must
    // never turn a correct implementation into a FAIL.
    bodyMatches =
      request.expectBodyContains === null ||
      (redactedResponseBody !== null && redactedResponseBody.includes(request.expectBodyContains));
    if ((statusMatches && bodyMatches) || input.poll === undefined) break;
    if (now() + input.poll.intervalSeconds * 1000 > deadline) break;
    await sleep(input.poll.intervalSeconds * 1000);
  }
  const waitedMs = now() - started;

  const sanitizedResponseHeaders = sanitizeHeaders(response.headers, redactor);
  const sanitizedResponseBody = truncateBody(redactedResponseBody);
  const passed = statusMatches && bodyMatches;
  const sequenced = setupRequests.length > 0 || input.poll !== undefined;

  const metadata = {
    method: request.method,
    path: redactedPath,
    status: response.status,
    expectStatus: request.expectStatus,
    expectBodyContains: redactedExpectBodyContains,
    passed,
    request: {
      headers: sanitizedRequestHeaders,
      ...bodyMetadata(sanitizedRequestBody),
    },
    response: {
      headers: sanitizedResponseHeaders,
      ...bodyMetadata(sanitizedResponseBody),
    },
    ...(sequenced ? { setup: setupRecords, polls, waitedMs } : {}),
  };

  const artifact = buildArtifact(assertion.id, metadata);
  // The proof pack reads the requests in order from the reason.
  const before = setupRecords.map((record) => `${record.method} ${record.path} returned ${String(record.status)}, then `).join("");
  const after = input.poll === undefined ? "" : ` after ${String(polls)} ${polls === 1 ? "request" : "requests"} in ${seconds(waitedMs)}`;

  if (passed) {
    return {
      assertionId: assertion.id,
      method: assertion.method,
      result: "PASS",
      reason: `${before}${request.method} ${redactedPath} returned the expected status ${String(request.expectStatus)}${after}.`,
      artifacts: [artifact],
    };
  }

  const reason = !statusMatches
    ? `${before}${request.method} ${redactedPath} expected status ${String(request.expectStatus)} but observed ${String(response.status)}${after}.`
    : `${before}${request.method} ${redactedPath} expected the response body to hold "${String(redactedExpectBodyContains)}", which was absent${after}.`;

  return {
    assertionId: assertion.id,
    method: assertion.method,
    result: "FAIL",
    reason,
    artifacts: [artifact],
  };
};
