import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getDrainModeOptions, getDrainModeQueryKey } from "@/api/@tanstack/react-query.gen";
import { setDrainMode } from "@/api/sdk.gen";
import { Switch } from "@/components/form";
import { Alert, Badge, Empty, ErrorAlert, Section, SkeletonRows } from "@/components/layout";
import { statusTone } from "@/features/runs/run-format";

/** The drain mode summary, read every minute, so the banner and the open runs stay current. */
export function useDrainMode() {
  return useQuery({ ...getDrainModeOptions(), refetchInterval: 60_000 });
}

/**
 * docs/specs/drain-mode.md. Drain mode before a release that open runs cannot replay: new runs wait,
 * open runs finish, and the deploy is safe once the list below is empty.
 */
export function DrainSection({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const drain = useDrainMode();
  const toggle = useMutation({
    mutationFn: async (on: boolean) => (await setDrainMode({ body: { on }, throwOnError: true })).data,
    onSuccess: (data) => qc.setQueryData(getDrainModeQueryKey(), data),
  });
  const view = drain.data;
  const open = view?.openRuns ?? [];
  return (
    <Section
      title="Drain mode"
      description="Turn it on before a release that open runs cannot replay. New runs wait, and every open run finishes. Deploy when no run is open. A worker of the newer release turns drain mode off and starts the waiting runs."
      className="lg:col-span-2"
      actions={
        view ? (
          <Switch
            checked={view.on}
            disabled={!canEdit || toggle.isPending}
            onCheckedChange={(on) => toggle.mutate(on)}
            label={view.on ? "On" : "Off"}
          />
        ) : null
      }
    >
      {drain.isPending ? <SkeletonRows rows={2} label="Loading drain mode" /> : null}
      <ErrorAlert error={drain.error ?? toggle.error} title="Drain mode did not load or change" />
      {view ? (
        <div className="space-y-3">
          {view.on ? (
            <Alert tone="warning" title={`${String(view.heldCount)} ${view.heldCount === 1 ? "run waits" : "runs wait"} for the update`}>
              Release {view.release ?? "unknown"} turned drain mode on
              {view.startedAt ? ` at ${new Date(view.startedAt).toLocaleString()}` : ""}.{" "}
              {open.length === 0 ? "No run is open, so the deploy is safe." : `Deploy when the ${String(open.length)} open ${open.length === 1 ? "run ends" : "runs end"}.`}
            </Alert>
          ) : null}
          {canEdit ? (
            open.length === 0 ? (
              <Empty>No run is open.</Empty>
            ) : (
              <ul className="divide-y divide-hairline">
                {open.map((run) => (
                  <li key={run.workflowId} className="flex flex-wrap items-center gap-2 py-2">
                    <Badge tone={statusTone(run.status ?? "")}>{run.status ?? "no row"}</Badge>
                    {run.runId ? (
                      <Link to="/runs/$runId" params={{ runId: run.runId }} className="link min-w-0 flex-1 truncate">
                        {run.workItemTitle ?? run.workflowId}
                      </Link>
                    ) : (
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{run.workflowId}</span>
                    )}
                    <span className="text-xs text-mute">
                      {run.release === null ? "release unknown" : `release ${run.release}`}
                      {run.createdAt ? `, since ${new Date(run.createdAt).toLocaleString()}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
