import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getRunOptions } from "@/api/@tanstack/react-query.gen";
import type { GetRunResponse } from "@/api/types.gen";
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

/** docs/specs/run-visibility.md. One run: why it ended, where its time went and what it cost. */
export function RunPage({ runId, ws }: { runId: string; ws?: string }) {
  const me = useMe();
  const workspace = pickWorkspace(me.data?.memberships ?? [], ws);
  const run = useQuery({
    ...getRunOptions({ path: { id: runId }, query: { linearWorkspaceId: workspace?.linearWorkspaceId ?? "" } }),
    enabled: Boolean(workspace),
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
  return <RunDetail run={run.data} crumb={back} admin={workspace.admin} workspaceId={workspace.linearWorkspaceId} />;
}

function RunDetail({
  run,
  crumb,
  admin,
  workspaceId,
}: {
  run: Run;
  crumb: React.ReactNode;
  admin: boolean;
  workspaceId: string;
}) {
  const identifier = issueIdentifier(run.workItemUrl);
  return (
    <>
      <PageHeader
        crumb={
          <>
            {crumb} / {identifier ?? run.id.slice(0, 8)}
          </>
        }
        title={run.workItemTitle ?? "Untitled run"}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(run.status)}>{run.status}</Badge>
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
              { label: "Cost", value: formatCost(run.costUsd) },
              { label: "Repairs", value: `${run.repairCount}${run.repairLimit === null ? "" : ` of ${run.repairLimit}`}` },
              { label: "Autonomy", value: run.autonomyLevel },
              { label: "Started", value: formatDate(run.createdAt) },
              { label: "Ended", value: run.completedAt ? formatDate(run.completedAt) : "—" },
              { label: "Base", value: run.baseSha ? <code>{run.baseSha.slice(0, 12)}</code> : "—" },
              ...(run.skillResolutionId
                ? [{ label: "Skills", value: <code>{`${run.skillRegistrySet ?? "all"} @ ${run.skillResolutionId.slice(0, 12)}`}</code> }]
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
                Pull request
              </a>
            ) : null}
            {admin ? (
              <a className="link" href={temporalWorkflowUrl(run.temporalWorkflowId)} target="_blank" rel="noreferrer">
                Workflow in Temporal
              </a>
            ) : null}
          </div>
        </Section>
        <Section title="Stages" description="Each stage of the run, in order, with the attempt it served." className="lg:col-span-2">
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
          <li key={`${stage.stage}-${stage.attempt}-${index}`} className="grid grid-cols-[150px_minmax(0,1fr)_64px] items-center gap-3 text-sm">
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
          {assertion.result !== "PASS" && assertion.reason ? <p className="mt-1 text-mute">{assertion.reason}</p> : null}
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
            <Badge tone={finding.blocking ? "warning" : "neutral"}>{finding.blocking ? "blocking" : finding.severity}</Badge>
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
