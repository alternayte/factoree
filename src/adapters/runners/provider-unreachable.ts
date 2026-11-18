/**
 * docs/specs/provider-unreachable.md. A transient failure to reach the model provider from inside
 * the sandbox, for example a DNS lookup that answers `EAI_AGAIN`. The agent CLI backs off for
 * minutes and then exits 1 with no tokens used. Factoree reads the output for these errors, so
 * the Run can retry, and the failure names the cause.
 *
 * Detection is JSON aware, because the CLIs stream newline-delimited JSON events:
 * - Claude Code reports its own provider retry with a `{"type":"system","subtype":"api_retry"}`
 *   event during the backoff. Those events carry no `API Error` text and no connectivity code
 *   (`error_status: null`, `error: "unknown"`), so a plain string scan never sees the outage.
 *   An `api_retry` event is itself the marker.
 * - A `tool_result` or a `user` event echoes a tool's own `API Error … ETIMEDOUT`. That is the
 *   tool reaching a blocked host, not the agent's provider, so those events are skipped before
 *   any string match, to avoid cancelling a healthy session on the next long turn.
 * - A connectivity code alone is never enough. `ENOTFOUND`, `ECONNRESET`, `ETIMEDOUT` and even
 *   `EAI_AGAIN` appear in ordinary failures: an `npm install` or a test that reaches a blocked
 *   egress host. A code is read only on a non-skipped line that also carries the CLI's own
 *   API-error marker. The opencode `Can't reach the API server` phrase is itself such a marker.
 */

/** The connectivity failure codes a DNS or socket error surfaces. */
const CONNECTIVITY_CODE = /\b(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT)\b/;

/** The agent CLI prefixes its own provider failures with this marker. */
const API_ERROR_MARKER = /API Error/i;

/** opencode names a provider it cannot reach with this phrase; it is a marker on its own. */
const UNREACHABLE_PHRASE = /Can['’]t reach the API server/i;

/** How much of the end of the output the fast-fail check reads. */
const TAIL_CHARS = 2_000;

/** The kind of one output line for the provider-unreachable check. */
type LineKind =
  /** Blank, or a tool/user event echoing a code; it carries no signal and is skipped. */
  | "skip"
  /** The CLI's own provider error as text: the marker with a code, or the opencode phrase. */
  | "string-unreachable"
  /** A `{"type":"system","subtype":"api_retry"}` event: the CLI is retrying the provider. */
  | "retry-unreachable"
  /** Ordinary output. */
  | "normal";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** True when the text carries the CLI's own API-error marker with a connectivity code, or the phrase. */
const isUnreachableString = (text: string): boolean =>
  UNREACHABLE_PHRASE.test(text) || (API_ERROR_MARKER.test(text) && CONNECTIVITY_CODE.test(text));

/**
 * Classifies one raw output line. A JSON event is read for its type first: a tool result or a
 * user turn is skipped, an `api_retry` system event is the retry marker, and any other event
 * falls through to the string scan on its raw JSON text, so an error `result` event still counts.
 */
const classifyLine = (raw: string): LineKind => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "skip";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return isUnreachableString(trimmed) ? "string-unreachable" : "normal";
  }
  if (isRecord(parsed)) {
    const type = parsed["type"];
    // A tool result or a user turn echoes a tool's own error. It is not the agent's provider.
    if (type === "tool_result" || type === "user") return "skip";
    // Claude Code reports a provider retry with this event during its backoff. No text names it.
    if (type === "system" && parsed["subtype"] === "api_retry") return "retry-unreachable";
  }
  return isUnreachableString(trimmed) ? "string-unreachable" : "normal";
};

const splitLines = (text: string): string[] => text.split(/\r\n|\r|\n/);

/**
 * True when the output names a provider connectivity failure. A `string-unreachable` line counts
 * wherever it appears, because the CLI prints its own error once. An `api_retry` event counts
 * only as the last signal line, because the CLI prints one per retry and a session that recovered
 * then failed on the change must not read as an outage.
 */
export const isProviderUnreachableText = (text: string): boolean => {
  const kinds = splitLines(text)
    .map(classifyLine)
    .filter((kind) => kind !== "skip");
  if (kinds.includes("string-unreachable")) return true;
  return kinds.at(-1) === "retry-unreachable";
};

/**
 * True when the output ends in a provider connectivity signal, so the CLI is still stuck in its
 * backoff. The check is on the last signal line of the tail, after blank, tool and user lines are
 * dropped: a working session that logged a tool's `ETIMEDOUT` and then went quiet on a long turn
 * did not write a provider error last, so it is not matched and not cancelled.
 */
export const endsInProviderUnreachable = (output: string): boolean => {
  const last = splitLines(output.slice(-TAIL_CHARS))
    .map(classifyLine)
    .filter((kind) => kind !== "skip")
    .at(-1);
  return last === "string-unreachable" || last === "retry-unreachable";
};

/**
 * How long the output may show only connectivity errors before Factoree ends the session. It is
 * well under the silence limit, and far under the ~6.8 minutes the CLI spends in its own backoff.
 */
export const PROVIDER_UNREACHABLE_GRACE_MS = 60_000;
