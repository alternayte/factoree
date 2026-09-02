import type { Redactor } from "~/telemetry/redaction.js";

/** SDD section 61. Factoree retains a bounded log of a failure, never a full transcript. */
export const MAX_RETAINED_LOG_BYTES = 32 * 1024;

/** Keeps the tail of a text, because a failure appears at the end of a log. */
const tail = (text: string): string => {
  if (Buffer.byteLength(text, "utf8") <= MAX_RETAINED_LOG_BYTES) return text;
  const kept = Buffer.from(text, "utf8").subarray(-MAX_RETAINED_LOG_BYTES).toString("utf8");
  return `[Factoree truncated this log to the last ${MAX_RETAINED_LOG_BYTES} bytes.]\n${kept}`;
};

/**
 * Builds the retained log of a failure. SDD section 60 requires redaction before any text leaves
 * the sandbox, and the redactor must see the complete output. Truncation before redaction can cut
 * a secret value at the byte boundary, and the surviving half then matches no exact secret value
 * and no provider credential pattern. Redaction runs first, on the full text, so a secret cannot
 * be split out of its own match. Truncation runs after, on the redacted text, because a redaction
 * can change the length of the text in either direction and the byte cap must still hold on what
 * Factoree actually retains.
 *
 * Two callers share this rule: a failing deterministic verification command, and an agent session
 * that did not finish. One copy keeps the order of the two steps from drifting apart.
 */
export const buildRetainedLog = (redactor: Redactor, stdout: string, stderr: string): string =>
  tail(redactor.redactText(`--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`));
