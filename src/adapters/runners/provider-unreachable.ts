/**
 * docs/specs/provider-unreachable.md. A transient failure to reach the model provider from inside
 * the sandbox, for example a DNS lookup that answers `EAI_AGAIN`. The agent CLI backs off for
 * minutes and then exits 1 with no tokens used. Factoree reads the output for these patterns, so
 * the Run can retry, and the failure names the cause.
 */
const PROVIDER_UNREACHABLE_PATTERNS: readonly RegExp[] = [
  /\bEAI_AGAIN\b/,
  /\bENOTFOUND\b/,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /Can['’]t reach the API server/i,
];

/** How much of the end of the output the fast-fail check reads. */
const TAIL_CHARS = 2_000;

/** True when the text names a provider connectivity failure. */
export const isProviderUnreachableText = (text: string): boolean =>
  PROVIDER_UNREACHABLE_PATTERNS.some((pattern) => pattern.test(text));

/** True when the end of the output still shows the connectivity failure, so the CLI is still stuck in it. */
export const endsInProviderUnreachable = (output: string): boolean =>
  isProviderUnreachableText(output.slice(-TAIL_CHARS));

/**
 * How long the output may show only connectivity errors before Factoree ends the session. It is
 * well under the silence limit, and far under the ~6.8 minutes the CLI spends in its own backoff.
 */
export const PROVIDER_UNREACHABLE_GRACE_MS = 60_000;
