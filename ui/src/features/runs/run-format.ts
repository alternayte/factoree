/** docs/specs/run-visibility.md. The shared formatting of the Runs pages. */

/** The issue identifier, such as FAC-73, from a Linear issue URL. */
export function issueIdentifier(url: string | null): string | null {
  const match = url === null ? null : /\/issue\/([A-Z][A-Z0-9]*-\d+)/.exec(url);
  return match?.[1] ?? null;
}

/** A duration as a person reads it: 1h 4m, 4m 12s or 12s. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** A cost in US dollars. A small cost keeps four decimals, so it never reads as zero. */
export function formatCost(usd: number | null): string {
  if (usd === null) return "—";
  return usd < 0.1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatTokens(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

export type StatusTone = "success" | "warning" | "neutral" | "accent";

/**
 * The badge tone of a run status: success, a failure, or still at work. DRAFT_PUBLISHED is a
 * failure with a draft pull request, not a success (docs/specs/draft-of-failed-run.md).
 */
export function statusTone(status: string): StatusTone {
  if (status === "READY_FOR_HUMAN" || status === "REPORTED") return "success";
  if (
    status.startsWith("FAILED") ||
    status === "STALE_BASE" ||
    status.startsWith("BLOCKED") ||
    status === "DRAFT_PUBLISHED"
  )
    return "warning";
  if (status === "CANCELLED") return "neutral";
  return "accent";
}

/** The run statuses a person filters by. */
export const STATUS_FILTERS = [
  "READY_FOR_HUMAN",
  "FAILED",
  "FAILED_REVIEW",
  "FAILED_CONFIGURATION",
  "STALE_BASE",
  "DRAFT_PUBLISHED",
  "CANCELLED",
  "QUEUED",
  "IMPLEMENTING",
  "REPAIRING",
] as const;

/** The Temporal UI page of one workflow, through the proxy at /temporal. */
export function temporalWorkflowUrl(namespace: string, workflowId: string): string {
  return `/temporal/namespaces/${encodeURIComponent(namespace)}/workflows/${encodeURIComponent(workflowId)}`;
}
