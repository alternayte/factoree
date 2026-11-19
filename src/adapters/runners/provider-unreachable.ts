/**
 * docs/specs/provider-unreachable.md. A transient failure to reach the model provider from inside
 * the sandbox, for example a DNS lookup that answers `EAI_AGAIN`. The agent CLI backs off for
 * minutes and then exits 1 with no tokens used. Factoree reads the output for these errors, so
 * the Run can retry, and the failure names the cause. The spec states every rule below.
 *
 * Detection is event aware, because the CLIs stream newline-delimited JSON events. Only the CLI's
 * own error is evidence, so a provider error is read from one extracted text field, never from
 * the serialized line:
 * - A Claude `{"type":"system","subtype":"api_retry"}` event counts only when `error_status` is
 *   null. A status such as 429 or 529 is the provider answering, and the CLI's backoff handles it.
 * - A plain line, the `result` of a `result` event with `is_error: true`, and the first text block
 *   of an assistant message that starts with `API Error:` count when that text also carries a
 *   connectivity code. The opencode `Can't reach the API server` phrase counts on its own, in a
 *   plain line or in the message of an `error` event. No opencode outage stream is captured, so
 *   that shape is unconfirmed.
 * - A tool input, a `tool_use` block, a `tool_result`, a `user` event and every other JSON field
 *   are never scanned. They echo code the agent wrote and tools that reached a blocked host.
 * - A line is classified only when it is complete. The tail of an output starts at a line break,
 *   so a cut JSON line never falls back to plain-text classification.
 */

import { assistantTextBlocks } from "./assistant-text.js";

/** The connectivity failure codes a DNS or socket error surfaces. */
const CONNECTIVITY_CODE = /\b(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT)\b/;

/** The agent CLI prefixes its own provider failures with this marker. */
const API_ERROR_MARKER = /API Error/i;

/** The CLI-owned prefix of an assistant message that reports a provider failure. */
const API_ERROR_PREFIX = "API Error:";

/** opencode names a provider it cannot reach with this phrase; it is a marker on its own. */
const UNREACHABLE_PHRASE = /Can['’]t reach the API server/i;

/** How much of the end of the output the tail check reads. */
const TAIL_CHARS = 2_000;

/**
 * One classified output line. A `skip` line is blank. `provider-error` is the CLI's own error as
 * text. `connectivity-retry` is an `api_retry` event with a null `error_status`, and `other-retry`
 * one with a status. `normal` is every other complete line.
 */
export type ProviderSignal =
  | { kind: "skip" }
  | { kind: "normal" }
  | { kind: "provider-error" }
  | { kind: "connectivity-retry" }
  | { kind: "other-retry" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** True when the text carries the CLI's own API-error marker with a connectivity code, or the phrase. */
const isUnreachableString = (text: string): boolean =>
  UNREACHABLE_PHRASE.test(text) || (API_ERROR_MARKER.test(text) && CONNECTIVITY_CODE.test(text));

const PROVIDER_ERROR: ProviderSignal = { kind: "provider-error" };
const NORMAL: ProviderSignal = { kind: "normal" };

/** The message of an opencode `error` event: `error.data.message`, `error.message`, or a string. */
const opencodeErrorMessage = (error: unknown): string | null => {
  if (typeof error === "string") return error;
  if (!isRecord(error)) return null;
  const data = isRecord(error["data"]) ? error["data"] : undefined;
  for (const candidate of [data?.["message"], error["message"]]) {
    if (typeof candidate === "string") return candidate;
  }
  return null;
};

const classifyEvent = (event: Record<string, unknown>): ProviderSignal => {
  switch (event["type"]) {
    case "system":
      if (event["subtype"] !== "api_retry") return NORMAL;
      return event["error_status"] === null ? { kind: "connectivity-retry" } : { kind: "other-retry" };
    case "result": {
      const text = event["result"];
      return event["is_error"] === true && typeof text === "string" && isUnreachableString(text) ? PROVIDER_ERROR : NORMAL;
    }
    case "assistant": {
      const message = event["message"];
      const text = isRecord(message) ? assistantTextBlocks(message)[0] : undefined;
      return text !== undefined && text.trimStart().startsWith(API_ERROR_PREFIX) && isUnreachableString(text)
        ? PROVIDER_ERROR
        : NORMAL;
    }
    case "error": {
      const message = opencodeErrorMessage(event["error"]);
      return message !== null && UNREACHABLE_PHRASE.test(message) ? PROVIDER_ERROR : NORMAL;
    }
    default:
      return NORMAL;
  }
};

/** Classifies one raw output line. */
const classifyLine = (raw: string): ProviderSignal => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "skip" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return isUnreachableString(trimmed) ? PROVIDER_ERROR : NORMAL;
  }
  if (!isRecord(parsed)) return isUnreachableString(trimmed) ? PROVIDER_ERROR : NORMAL;
  return classifyEvent(parsed);
};

const splitLines = (text: string): string[] => text.split(/\r\n|\r|\n/);

/** The text up to and including its last line break: the complete lines of a live output. */
const completeLinesOf = (text: string): string => {
  const end = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
  return end === -1 ? "" : text.slice(0, end + 1);
};

/**
 * The signals of the complete lines of an output, in order, without the blank lines. A trailing
 * fragment with no line break is not classified, because it may be half of a JSON event. `final`
 * is for an output whose process ended, where the last line is complete too.
 */
export const readProviderSignals = (output: string, options: { final?: boolean } = {}): ProviderSignal[] => {
  const text = options.final === true ? output : completeLinesOf(output);
  return splitLines(text)
    .map(classifyLine)
    .filter((signal) => signal.kind !== "skip");
};

/**
 * The end of an output that starts at a line break. A character slice that starts inside a line
 * is moved to the next line, so a cut JSON event is never read as plain text.
 */
const tailOf = (output: string): string => {
  if (output.length <= TAIL_CHARS) return output;
  const start = output.length - TAIL_CHARS;
  const before = output[start - 1];
  if (before === "\n" || before === "\r") return output.slice(start);
  const next = output.slice(start).search(/[\r\n]/);
  return next === -1 ? "" : output.slice(start + next + 1);
};

/**
 * True when the output of a process that ended names a provider connectivity failure. A
 * `provider-error` line counts wherever it appears, because the CLI prints its own error once.
 * A connectivity retry counts only as the last signal, because the CLI prints one per retry and
 * a session that recovered then failed on the change must not read as an outage.
 */
export const isProviderUnreachableText = (text: string): boolean => {
  const signals = readProviderSignals(text, { final: true });
  if (signals.some((signal) => signal.kind === "provider-error")) return true;
  return signals.at(-1)?.kind === "connectivity-retry";
};

/**
 * True when the complete lines of the tail of a live output end in a provider connectivity
 * signal, so the CLI is still stuck in its backoff.
 */
export const endsInProviderUnreachable = (output: string): boolean => {
  const kind = readProviderSignals(tailOf(output)).at(-1)?.kind;
  return kind === "provider-error" || kind === "connectivity-retry";
};

/**
 * How long the output may show only connectivity errors before Factoree ends the session. It is
 * well under the silence limit, and far under the ~6.8 minutes the CLI spends in its own backoff.
 */
export const PROVIDER_UNREACHABLE_GRACE_MS = 60_000;

/**
 * How many consecutive connectivity retries make the fast-fail eligible. One retry can precede a
 * long healthy turn, because the Claude runner streams only complete messages.
 */
export const PROVIDER_UNREACHABLE_MIN_RETRIES = 3;

/**
 * The fast-fail state of one output stream. It reads the complete lines that a poll added, never
 * the whole output again, and keeps the run of consecutive connectivity events and the time the
 * session may be cancelled. Any other complete event ends the run.
 *
 * The deadline is anchored at the first event of the run. The CLI writes a retry after each failed
 * try, sooner than the grace, so a deadline that each retry moved forward would never pass and the
 * session would burn the whole backoff.
 */
export class ProviderOutageWatch {
  private consumed = 0;
  private run = 0;
  private runStartedAt: number | null = null;
  private due: number | null = null;

  constructor(private readonly graceMs: number) {}

  /** When the session may be cancelled for this stream, or null while it is not eligible. */
  get deadline(): number | null {
    return this.due;
  }

  /** Forgets the run and the deadline, and keeps the lines already read. */
  clear(): void {
    this.run = 0;
    this.runStartedAt = null;
    this.due = null;
  }

  /**
   * Reads the text a stream holds at `now`. `modelActivity` is true when a complete event that
   * is neither a connectivity retry nor a provider error was added: the CLI is working.
   */
  feed(text: string, now: number): { modelActivity: boolean } {
    // A stream only grows. A shorter text is a new stream, and it is read from its start.
    if (text.length < this.consumed) {
      this.consumed = 0;
      this.clear();
    }
    const complete = completeLinesOf(text.slice(this.consumed));
    this.consumed += complete.length;
    let modelActivity = false;
    for (const signal of readProviderSignals(complete)) {
      switch (signal.kind) {
        case "connectivity-retry":
          this.run += 1;
          this.runStartedAt ??= now;
          this.due = this.run >= PROVIDER_UNREACHABLE_MIN_RETRIES ? this.runStartedAt + this.graceMs : null;
          break;
        case "provider-error":
          this.run = Math.max(this.run, PROVIDER_UNREACHABLE_MIN_RETRIES);
          this.runStartedAt ??= now;
          this.due = this.runStartedAt + this.graceMs;
          break;
        default:
          this.clear();
          modelActivity = true;
      }
    }
    return { modelActivity };
  }
}
