import type { GetRunResponse, ListRunEventsResponse } from "@/api/types.gen";
import { Alert, Badge, Empty } from "@/components/layout";
import { formatDate } from "@/lib/utils";

export type RunEventItem = ListRunEventsResponse["items"][number];
export type DiagnosisView = NonNullable<GetRunResponse["diagnosis"]>;

const FAULT_KINDS = new Set(["session_failed", "session_hung", "provider_unreachable", "command_failed", "plan_rejected", "proposal_rejected"]);

const kindLabel: Record<RunEventItem["kind"], string> = {
  session_failed: "session failed",
  session_hung: "session hung",
  provider_unreachable: "provider unreachable",
  command_failed: "command failed",
  plan_rejected: "plan rejected",
  proposal_rejected: "proposal rejected",
  selector_recheck: "selector re-check",
  check_unstable: "unstable check",
  retry_started: "retry",
  repair_started: "repair",
  run_ended: "ended",
};

/** The egress facts and the log of a session or command fault, or nothing for any other kind. */
function FaultFacts({ event }: { event: RunEventItem }) {
  if (event.kind !== "session_failed" && event.kind !== "provider_unreachable" && event.kind !== "command_failed") return null;
  const detail = event.detail;
  return (
    <div className="mt-2 flex flex-col gap-1.5 text-sm">
      {event.kind === "command_failed" ? (
        <p>
          <span className="text-mute">Command </span>
          <code className="break-all">{event.detail.command}</code>
          {event.detail.exitCode === null ? null : <span className="text-mute"> exited {event.detail.exitCode}</span>}
        </p>
      ) : (
        <p>
          <span className="text-mute">Runner </span>
          <code>{event.detail.runner}</code>
          {event.detail.model ? <span className="text-mute"> on {event.detail.model}</span> : null}
          <span className="text-mute"> exited {event.detail.exitCode ?? "—"}</span>
        </p>
      )}
      {detail.egress === "recorded" ? (
        <p>
          <span className="text-mute">Denied by the egress log: </span>
          {detail.deniedHosts.length === 0 ? "none" : <code className="break-all">{detail.deniedHosts.join(", ")}</code>}
        </p>
      ) : (
        <p className="text-mute">
          {detail.egress === "not_recorded"
            ? "This sandbox provider records no egress, so no denied host is known."
            : "The egress log of the sandbox could not be read."}
        </p>
      )}
      {detail.hostHints.length > 0 ? (
        <p>
          <span className="text-mute">Hosts in the output that the allow list does not hold (a hint, not evidence): </span>
          <code className="break-all">{detail.hostHints.join(", ")}</code>
        </p>
      ) : null}
      {detail.log ? (
        <details>
          <summary className="cursor-pointer text-mute">Output tail</summary>
          <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-hairline/40 p-2 font-mono text-xs">{detail.log}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** docs/specs/run-diagnostics.md. How a failed run or setup ended, and the fault that caused it. */
export function Diagnosis({ diagnosis, className }: { diagnosis: DiagnosisView; className?: string }) {
  const where = [diagnosis.stage, diagnosis.attempt !== null && diagnosis.attempt > 0 ? `attempt ${diagnosis.attempt}` : null]
    .filter(Boolean)
    .join(", ");
  return (
    <Alert tone="warning" className={className} title={`Why it ended${where ? ` (${where})` : ""}`}>
      <p className="whitespace-pre-wrap">{diagnosis.message}</p>
      {diagnosis.cause ? (
        <div className="mt-3 border-t border-hairline pt-3">
          <p className="font-medium text-ink">
            Cause: {kindLabel[diagnosis.cause.kind]}
            {diagnosis.cause.role ? ` (${diagnosis.cause.role})` : ""}
          </p>
          <p className="whitespace-pre-wrap">{diagnosis.cause.message}</p>
          <FaultFacts event={diagnosis.cause} />
        </div>
      ) : (
        <p className="mt-2 text-mute">Factoree recorded no fault event for this end.</p>
      )}
    </Alert>
  );
}

/** docs/specs/run-diagnostics.md. The faults and the Factoree decisions, in order. */
export function EventList({ events }: { events: RunEventItem[] }) {
  if (events.length === 0) return <Empty>Factoree recorded no fault and no decision.</Empty>;
  return (
    <ol className="flex flex-col divide-y divide-hairline">
      {events.map((event) => (
        <li key={event.id} className="py-2.5 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={FAULT_KINDS.has(event.kind) ? "danger" : event.kind === "run_ended" ? "neutral" : "accent"}>
              {kindLabel[event.kind]}
            </Badge>
            <span className="font-mono text-xs text-mute">
              {event.stage}
              {event.attempt > 0 ? ` #${event.attempt}` : ""}
              {event.role ? ` · ${event.role}` : ""}
            </span>
            <span className="ml-auto text-xs text-mute">{formatDate(event.createdAt)}</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm">{event.message}</p>
          <FaultFacts event={event} />
        </li>
      ))}
    </ol>
  );
}
