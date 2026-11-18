/**
 * docs/specs/provider-unreachable.md. A transient failure to reach the model provider from inside
 * the sandbox, for example a DNS lookup that answers `EAI_AGAIN`. The agent CLI backs off for
 * minutes and then exits 1 with no tokens used. Factoree reads the output for these errors, so
 * the Run can retry, and the failure names the cause.
 *
 * The connectivity codes alone are not enough. `ENOTFOUND`, `ECONNRESET`, `ETIMEDOUT` and even
 * `EAI_AGAIN` appear in ordinary failures too: an `npm install` or a test that reaches a blocked
 * egress host, a tool result echoed in the stream, or an egress allow-list block. Only the agent
 * CLI's own provider error counts, so a code is read only on a line that also carries the CLI's
 * API-error marker. The `Can't reach the API server` phrase is itself such a marker.
 */

/** The connectivity failure codes a DNS or socket error surfaces. */
const CONNECTIVITY_CODE = /\b(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT)\b/;

/** The agent CLI prefixes its own provider failures with this marker. */
const API_ERROR_MARKER = /API Error/i;

/** opencode names a provider it cannot reach with this phrase; it is a marker on its own. */
const UNREACHABLE_PHRASE = /Can['’]t reach the API server/i;

/** How much of the end of the output the fast-fail check reads. */
const TAIL_CHARS = 2_000;

/**
 * True when one line is the agent CLI's own provider connectivity error, not a tool result or a
 * test that echoed one of the codes.
 */
const isProviderUnreachableLine = (line: string): boolean =>
  UNREACHABLE_PHRASE.test(line) || (API_ERROR_MARKER.test(line) && CONNECTIVITY_CODE.test(line));

const splitLines = (text: string): string[] => text.split(/\r\n|\r|\n/);

/** True when any line of the text is the agent CLI reporting a provider connectivity failure. */
export const isProviderUnreachableText = (text: string): boolean =>
  splitLines(text).some(isProviderUnreachableLine);

/**
 * True when the output ends in a provider connectivity error line, so the CLI is still stuck in
 * its backoff. The check is on the last non-empty line, not on any text in the tail: a working
 * session that logged a tool's `ETIMEDOUT` and then went quiet on a long turn did not write that
 * error last, so it is not matched and not cancelled.
 */
export const endsInProviderUnreachable = (output: string): boolean => {
  const lines = splitLines(output.slice(-TAIL_CHARS))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  return last !== undefined && isProviderUnreachableLine(last);
};

/**
 * How long the output may show only connectivity errors before Factoree ends the session. It is
 * well under the silence limit, and far under the ~6.8 minutes the CLI spends in its own backoff.
 */
export const PROVIDER_UNREACHABLE_GRACE_MS = 60_000;
