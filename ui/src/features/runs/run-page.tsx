import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { getRunOptions, getRunQueryKey } from "@/api/@tanstack/react-query.gen";
import { publishRunDraft, stopRun } from "@/api/sdk.gen";
import type { GetRunResponse } from "@/api/types.gen";
import { Button } from "@/components/button";
import { Confirm } from "@/components/confirm";
import {
  Alert,
  Badge,
  Empty,
  ErrorAlert,
  KeyValue,
  Loading,
  PageHeader,
  Section,
  Skeleton,
  SkeletonCard,
  TableCard,
} from "@/components/layout";
import { useMe } from "@/lib/session";
import { formatDate } from "@/lib/utils";
import { pickWorkspace } from "@/lib/workspace";
import {
  formatCost,
  formatDuration,
  formatTokens,
  issueIdentifier,
  statusTone,
  temporalWorkflowUrl,
} from "./run-format";

type Run = GetRunResponse;

/** How long the page polls for the draft pull request after it asked for one. */
const DRAFT_POLL_MS = 5 * 60_000;

/** docs/specs/run-visibility.md. One run: why it ended, where its time went and what it cost. */
export function RunPage({ runId, ws }: { runId: string; ws?: string }) {
  const me = useMe();
  const workspace = pickWorkspace(me.data?.memberships ?? [], ws);
  // Issue #45. True once this page sent a stop, so it polls even when the stop record is late.
  const [stopSent, setStopSent] = useState(false);
  // docs/specs/draft-of-failed-run.md. When this page asked for a draft, so it polls until the draft opens.
  const [draftSentAt, setDraftSentAt] = useState<number | null>(null);
  const run = useQuery({
    ...getRunOptions({ path: { id: runId }, query: { linearWorkspaceId: workspace?.linearWorkspaceId ?? "" } }),
    enabled: Boolean(workspace),
    // A stopped run polls until it ends, so a stop that takes time to reach the activity shows.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && draftSentAt !== null && data.status !== "DRAFT_PUBLISHED" && Date.now() - draftSentAt < DRAFT_POLL_MS) return 3000;
      return data && !data.terminal && (stopSent || data.stopRequestedAt !== null) ? 3000 : false;
    },
  });
  const back = (
    <Link to="/runs" search={ws ? { ws } : {}} className="hover:text-body">
      runs
    </Link>
  );
  if (!workspace) {
    return (
      <>
        <PageHeader crumb={back} title="Run" />
        <Alert tone="info">You are a member of no workspace where Factoree is installed.</Alert>
      </>
    );
  }
  if (run.isPending) {
    return (
      <Loading label="Loading the run" className="mb-6">
        <Skeleton className="h-2.5 w-28" />
        <Skeleton className="mt-3 h-5 w-64" />
        <SkeletonCard fields={4} />
      </Loading>
    );
  }
  if (run.isError) {
    return (
      <>
        <PageHeader crumb={back} title="Run" />
        <ErrorAlert error={run.error} title="The run did not load" />
      </>
    );
  }
  return (
    <RunDetail
      run={run.data}
      crumb={back}
      admin={workspace.admin}
      workspaceId={workspace.linearWorkspaceId}
      temporalNamespace={me.data?.temporalNamespace ?? "default"}
      stopping={!run.data.terminal && (stopSent || run.data.stopRequestedAt !== null)}
      onStopped={() => setStopSent(true)}
      draftSent={draftSentAt !== null && run.data.status !== "DRAFT_PUBLISHED"}
      onDraftSent={() => setDraftSentAt(Date.now())}
    />
  );
}

function RunDetail({
  run,
  crumb,
  admin,
  workspaceId,
  temporalNamespace,
  stopping,
  onStopped,
  draftSent,
  onDraftSent,
}: {
  run: Run;
  crumb: React.ReactNode;
  admin: boolean;
  workspaceId: string;
  temporalNamespace: string;
  stopping: boolean;
  onStopped: () => void;
  draftSent: boolean;
  onDraftSent: () => void;
}) {
  const identifier = issueIdentifier(run.workItemUrl);
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const stop = useMutation({
    mutationFn: async () =>
      stopRun({ path: { id: run.id }, body: { linearWorkspaceId: workspaceId }, throwOnError: true }),
    onSuccess: () => {
      setConfirming(false);
      onStopped();
      void qc.invalidateQueries({
        queryKey: getRunQueryKey({ path: { id: run.id }, query: { linearWorkspaceId: workspaceId } }),
      });
    },
  });
  // docs/specs/draft-of-failed-run.md. A workspace admin publishes the last patch of a failed run as a draft.
  const [confirmingDraft, setConfirmingDraft] = useState(false);
  const draft = useMutation({
    mutationFn: async () =>
      publishRunDraft({ path: { id: run.id }, body: { linearWorkspaceId: workspaceId }, throwOnError: true }),
    onSuccess: () => {
      setConfirmingDraft(false);
      onDraftSent();
      void qc.invalidateQueries({
        queryKey: getRunQueryKey({ path: { id: run.id }, query: { linearWorkspaceId: workspaceId } }),
      });
    },
  });
  const hours = run.sandboxRetentionHours;
  return (
    <>
      <PageHeader
        actions={
          // Issue #45. A workspace admin stops a run that has not ended. The badge shows the stop until the run ends.
          admin && !run.terminal && !stopping ? (
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Stop run
            </Button>
          ) : admin && run.draftQualifies && !draftSent ? (
            <Button onClick={() => setConfirmingDraft(true)}>Publish as draft</Button>
          ) : null
        }
        crumb={
          <>
            {crumb} / {identifier ?? run.id.slice(0, 8)}
          </>
        }
        title={run.workItemTitle ?? "Untitled run"}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(run.status)}>{run.status}</Badge>
            {stopping ? <Badge tone="neutral">Stopping…</Badge> : null}
            {draftSent ? <Badge tone="neutral">Publishing the draft…</Badge> : null}
            {run.failureReason ? <span className="font-mono text-xs">{run.failureReason}</span> : null}
            <span>{run.productName}</span>
          </span>
        }
      />
      {run.followUpOfRunId ? (
        <Alert tone="info" className="mb-4">
          This run follows up a failed run.{" "}
          <Link to="/runs/$runId" params={{ runId: run.followUpOfRunId }} search={{ ws: workspaceId }} className="link">
            Open the failed run
          </Link>
        </Alert>
      ) : null}
      {run.failureMessage ? (
        <Alert tone="warning" className="mb-4" title="Why the run ended">
          {run.failureMessage}
        </Alert>
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:items-start">
        <Section title="Run" className="lg:col-span-1">
          <KeyValue
            items={[
              { label: "Duration", value: formatDuration(run.durationMs) },
              { label: "Waited", value: run.waitedMs > 0 ? formatDuration(run.waitedMs) : "—" },
              { label: "Sandbox provider", value: run.sandboxProvider ?? "—" },
              { label: "Cost", value: formatCost(run.costUsd) },
              {
                label: "Repairs",
                value: `${run.repairCount}${run.repairLimit === null ? "" : ` of ${run.repairLimit}`}`,
              },
              { label: "Autonomy", value: run.autonomyLevel },
              { label: "Started", value: formatDate(run.createdAt) },
              { label: "Ended", value: run.completedAt ? formatDate(run.completedAt) : "—" },
              ...(run.stopSource
                ? [
                    {
                      label: "Stopped from",
                      value:
                        run.stopSource === "factoree_ui"
                          ? `Factoree UI${run.stopRequestedBy ? ` by ${run.stopRequestedBy}` : ""}`
                          : "Linear",
                    },
                  ]
                : []),
              ...(run.draftSource
                ? [
                    {
                      label: "Draft asked from",
                      value: `${run.draftSource === "factoree_ui" ? "Factoree UI" : "Linear"}${run.draftRequestedBy ? ` by ${run.draftRequestedBy}` : ""}`,
                    },
                  ]
                : []),
              { label: "Base", value: run.baseSha ? <code>{run.baseSha.slice(0, 12)}</code> : "—" },
              ...(run.skillResolutionId
                ? [
                    {
                      label: "Skills",
                      value: <code>{`${run.skillRegistrySet ?? "all"} @ ${run.skillResolutionId.slice(0, 12)}`}</code>,
                    },
                  ]
                : []),
            ]}
          />
          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            {run.workItemUrl ? (
              <a className="link" href={run.workItemUrl} target="_blank" rel="noreferrer">
                Linear issue
              </a>
            ) : null}
            {run.pullRequestUrl ? (
              <a className="link" href={run.pullRequestUrl} target="_blank" rel="noreferrer">
                {run.status === "DRAFT_PUBLISHED" ? "Draft pull request" : "Pull request"}
              </a>
            ) : null}
            {admin ? (
              <a className="link" href={temporalWorkflowUrl(temporalNamespace, run.temporalWorkflowId)} target="_blank" rel="noreferrer">
                Workflow in Temporal
              </a>
            ) : null}
          </div>
        </Section>
        <Section
          title="Stages"
          description="Each stage of the run, in order, with the attempt it served."
          className="lg:col-span-2"
        >
          <StageTimeline run={run} />
        </Section>
      </div>
      <Section title="Agent sessions" className="mt-4">
        <Sessions run={run} />
      </Section>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
        <Section title="Assertions" description="The result of each frozen assertion in each attempt.">
          <Assertions run={run} />
        </Section>
        <Section title="Review findings">
          <Findings run={run} />
        </Section>
      </div>
      {run.skills.length > 0 || run.skillProposals.length > 0 ? (
        <Section title="Skills" className="mt-4">
          <Skills run={run} />
        </Section>
      ) : null}
      <Confirm
        open={confirming}
        title="Stop this run?"
        confirmLabel="Stop run"
        mutation={stop}
        onCancel={() => {
          setConfirming(false);
          stop.reset();
        }}
        onConfirm={() => stop.mutate()}
      >
        <p>
          Factoree stops the agents and the checks, and the Run ends as Cancelled. A cancelled run takes no reply;
          delegate the issue again to start a new one. Work so far stays in the retained sandbox for {hours}{" "}
          {hours === 1 ? "hour" : "hours"}.
        </p>
        <ErrorAlert error={stop.error} className="mt-3" />
      </Confirm>
      <Confirm
        open={confirmingDraft}
        title="Publish this run as a draft?"
        confirmLabel="Publish as draft"
        mutation={draft}
        onCancel={() => {
          setConfirmingDraft(false);
          draft.reset();
        }}
        onConfirm={() => draft.mutate()}
      >
        <p>
          Factoree publishes the last patch of this run as a draft pull request on its base SHA. The checks did not pass,
          so the body lists what failed, and only a human marks it ready. The run ends as Draft published and the Linear
          issue keeps its state.
        </p>
        <ErrorAlert error={draft.error} className="mt-3" />
      </Confirm>
    </>
  );
}

function StageTimeline({ run }: { run: Run }) {
  if (run.stages.length === 0) return <Empty>No stage was recorded.</Empty>;
  const start = Math.min(...run.stages.map((stage) => Date.parse(stage.startedAt)));
  const end = Math.max(...run.stages.map((stage) => Date.parse(stage.endedAt)));
  const span = Math.max(1, end - start);
  return (
    <ol className="flex flex-col gap-1.5">
      {run.stages.map((stage, index) => {
        const from = Date.parse(stage.startedAt);
        const length = Date.parse(stage.endedAt) - from;
        return (
          <li
            key={`${stage.stage}-${stage.attempt}-${index}`}
            className="grid grid-cols-[150px_minmax(0,1fr)_64px] items-center gap-3 text-sm"
          >
            <span className="truncate font-mono text-xs">
              {stage.stage}
              {stage.attempt > 1 ? ` #${stage.attempt}` : ""}
            </span>
            <span className="relative h-2.5 rounded-full bg-hairline">
              <span
                className="absolute inset-y-0 rounded-full bg-accent"
                style={{ left: `${((from - start) / span) * 100}%`, width: `${Math.max(0.5, (length / span) * 100)}%` }}
              />
            </span>
            <span className="t-value text-right text-xs">{formatDuration(length)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Sessions({ run }: { run: Run }) {
  if (run.sessions.length === 0) return <Empty>No agent session was recorded.</Empty>;
  return (
    <TableCard>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col" className="text-right">
              Attempt
            </th>
            <th scope="col">Model</th>
            <th scope="col">Outcome</th>
            <th scope="col" className="text-right">
              Duration
            </th>
            <th scope="col" className="text-right">
              Model time
            </th>
            <th scope="col" className="text-right">
              Tool time
            </th>
            <th scope="col" className="text-right">
              Input tokens
            </th>
            <th scope="col" className="text-right">
              Output tokens
            </th>
            <th scope="col" className="text-right">
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {run.sessions.map((session, index) => (
            <tr key={`${session.role}-${session.attempt}-${index}`}>
              <td>{session.role}</td>
              <td className="t-value text-right">{session.attempt}</td>
              <td className="t-value">
                {session.model ?? "—"}
                {session.effort ? <span className="text-mute"> · {session.effort}</span> : null}
              </td>
              <td>
                <Badge tone={session.outcome === "finished" ? "success" : "warning"}>{session.outcome}</Badge>
              </td>
              <td className="t-value text-right">{formatDuration(session.durationMs)}</td>
              <td className="t-value text-right">{formatDuration(session.modelMs)}</td>
              <td className="t-value text-right">{formatDuration(session.toolMs)}</td>
              <td className="t-value text-right">{formatTokens(session.inputTokens)}</td>
              <td className="t-value text-right">{formatTokens(session.outputTokens)}</td>
              <td className="t-value text-right">{formatCost(session.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableCard>
  );
}

const resultTone = (result: string) => (result === "PASS" ? "success" : result === "UNSTABLE" ? "accent" : "warning");

function Assertions({ run }: { run: Run }) {
  if (run.assertions.length === 0) return <Empty>No assertion ran.</Empty>;
  return (
    <ul className="flex flex-col gap-3">
      {run.assertions.map((assertion) => (
        <li key={`${assertion.key}-${assertion.attempt}`} className="text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={resultTone(assertion.result)}>{assertion.result}</Badge>
            <span className="font-mono text-xs">{assertion.key}</span>
            <span className="text-mute">
              attempt {assertion.attempt} · {assertion.method}
            </span>
          </div>
          <p className="mt-1">{assertion.statement}</p>
          {assertion.result !== "PASS" && assertion.reason ? (
            <p className="mt-1 text-mute">{assertion.reason}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Findings({ run }: { run: Run }) {
  if (run.findings.length === 0) return <Empty>The review reported no finding.</Empty>;
  return (
    <ul className="flex flex-col gap-3">
      {run.findings.map((finding) => (
        <li key={`${finding.attempt}-${finding.key}`} className="text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={finding.blocking ? "warning" : "neutral"}>
              {finding.blocking ? "blocking" : finding.severity}
            </Badge>
            <span className="font-mono text-xs">{finding.key}</span>
            <span className="text-mute">
              attempt {finding.attempt} · {finding.category}
            </span>
          </div>
          <p className="mt-1">{finding.description}</p>
          <p className="mt-1 font-mono text-xs text-mute">{finding.evidence}</p>
        </li>
      ))}
    </ul>
  );
}

function Skills({ run }: { run: Run }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap gap-2">
        {run.skills.map((skill) => (
          <Badge key={`${skill.source}-${skill.name}`} tone={skill.activated ? "success" : "neutral"}>
            {skill.name}
            {skill.version === null ? "" : ` v${skill.version}`} · {skill.source}
          </Badge>
        ))}
      </div>
      {run.skillProposals.map((proposal) => (
        <p key={`${proposal.source}-${proposal.name}`}>
          Skill proposal <span className="font-mono">{proposal.name}</span>: {proposal.state}
          {proposal.url ? (
            <>
              {" "}
              <a className="link" href={proposal.url} target="_blank" rel="noreferrer">
                review
              </a>
            </>
          ) : null}
          {proposal.reason ? <span className="text-mute"> {proposal.reason}</span> : null}
        </p>
      ))}
    </div>
  );
}
