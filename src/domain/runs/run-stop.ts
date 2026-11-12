/**
 * Issue #45, SDD section 50. Where a stop of a Run came from. A Linear stop is the Stop button of
 * the agent session. A Factoree UI stop is `POST /admin/runs/:id/stop` by a workspace admin.
 */
export const STOP_SOURCES = ["linear", "factoree_ui"] as const;

export type StopSource = (typeof STOP_SOURCES)[number];

/**
 * The payload of the `stop` signal. The signal also arrives with no argument, from a client older
 * than this payload or from the Temporal CLI, and the workflow reads that as a Linear stop
 * (DI-21.64).
 */
export interface StopRequest {
  source: StopSource;
  /** The name, or else the email, of the admin who stopped the Run from the Factoree UI. */
  by?: string | null;
}

/** The payload as the workflow received it, or null for a signal with no usable payload. */
export const readStopRequest = (value: unknown): StopRequest | null => {
  if (value === null || typeof value !== "object") return null;
  const source = (value as { source?: unknown }).source;
  if (typeof source !== "string" || !(STOP_SOURCES as readonly string[]).includes(source)) return null;
  const by = (value as { by?: unknown }).by;
  return { source: source as StopSource, by: typeof by === "string" && by.trim() !== "" ? by.trim() : null };
};

/**
 * The final response a stopped Run posts on its agent session. A Linear stop keeps the wording
 * from before issue #45. A Factoree UI stop names the source and the admin, because the human in
 * Linear did not press Stop.
 */
export const stopResponse = (request: StopRequest | null, pullRequestUrl: string | null): string => {
  const opening =
    request?.source === "factoree_ui"
      ? `Stopped from the Factoree UI${request.by ? ` by ${request.by}` : ""}.`
      : "Factoree stopped this Run at your request.";
  return pullRequestUrl === null
    ? `${opening} No change was published.`
    : `${opening} The verified change is already published and waits for a human. Pull request: ${pullRequestUrl}.`;
};

/** Records who stopped a Run and from where. The first stop of a Run wins. */
export interface RunStopLog {
  record(tenantId: string, runId: string, request: StopRequest, at: Date): Promise<void>;
}
