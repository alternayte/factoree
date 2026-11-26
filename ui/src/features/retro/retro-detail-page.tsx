import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { getRetroOptions, getRetroQueryKey } from "@/api/@tanstack/react-query.gen";
import { createRetroFindingIssue, dismissRetroFinding } from "@/api/sdk.gen";
import { Button } from "@/components/button";
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
  Stack,
} from "@/components/layout";
import { Markdown } from "@/components/markdown";
import { formatCost, formatDuration } from "@/features/runs/run-format";
import { useMe } from "@/lib/session";
import { formatDate } from "@/lib/utils";
import { pickWorkspace } from "@/lib/workspace";
import {
  decimal,
  FINDING_STATUS_LABEL,
  formatBytes,
  formatDay,
  KIND_TONE,
  percent,
  retroTone,
  webResultLabel,
  type Finding,
  type RetroDetail,
  type WebResultRef,
} from "./retro-format";

const RUNNING_POLL_MS = 5_000;

/** docs/specs/retro-agent.md. One retro: the measured numbers and the session of each product, its events and its findings. */
export function RetroDetailPage({ retroId, ws }: { retroId: string; ws?: string }) {
  const me = useMe();
  const workspace = pickWorkspace(me.data?.memberships ?? [], ws);
  const linearWorkspaceId = workspace?.linearWorkspaceId ?? "";
  const retro = useQuery({
    ...getRetroOptions({ path: { id: retroId }, query: { linearWorkspaceId } }),
    enabled: Boolean(workspace),
    refetchInterval: (q) => (q.state.data?.status === "running" ? RUNNING_POLL_MS : false),
  });
  const crumb = (
    <Link to="/retro" search={ws ? { ws } : {}} className="hover:text-body">
      retro
    </Link>
  );

  if (!workspace) {
    return (
      <>
        <PageHeader crumb={crumb} title="Retro" />
        <Alert tone="info">You are a member of no workspace where Factoree is installed.</Alert>
      </>
    );
  }
  if (retro.isPending) {
    return (
      <>
        <Loading label="Loading the retro" className="mb-6">
          <Skeleton className="h-2.5 w-28" />
          <Skeleton className="mt-3 h-5 w-48" />
        </Loading>
        <Stack>
          <SkeletonCard fields={4} />
          <SkeletonCard fields={2} />
        </Stack>
      </>
    );
  }
  if (retro.isError) {
    return (
      <>
        <PageHeader crumb={crumb} title="Retro" />
        <ErrorAlert error={retro.error} title="The retro did not load" />
      </>
    );
  }
  const data = retro.data;
  return (
    <>
      <PageHeader
        crumb={
          <>
            {crumb} / {data.id.slice(0, 8)}
          </>
        }
        title={`Retro of ${formatDate(data.startedAt)}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={retroTone(data.status)}>{data.status}</Badge>
            <span>
              {data.findingCount} {data.findingCount === 1 ? "finding" : "findings"} · {formatCost(data.costUsd)}
            </span>
          </span>
        }
      />
      {data.failureMessage ? (
        <Alert tone="danger" title="The retro failed" className="mb-4">
          {data.failureMessage}
        </Alert>
      ) : null}
      <Stack>
        <Section title="Summary">
          <KeyValue
            items={[
              { label: "Trigger", value: data.trigger },
              {
                label: "Runs ended",
                prose: true,
                value: `${data.windowStart ? formatDate(data.windowStart) : "the start"} to ${formatDate(data.windowEnd)}`,
              },
              { label: "Started", prose: true, value: formatDate(data.startedAt) },
              { label: "Ended", prose: true, value: data.endedAt ? formatDate(data.endedAt) : "running" },
              { label: "Cost", value: formatCost(data.costUsd) },
              { label: "Prompt version", value: data.promptVersion },
            ]}
          />
        </Section>
        <ProductsSection retro={data} />
        <FindingsSection retro={data} linearWorkspaceId={linearWorkspaceId} canEdit={workspace.admin} />
        <SignalResultsSection retro={data} linearWorkspaceId={linearWorkspaceId} />
        <WebResearchSection retro={data} linearWorkspaceId={linearWorkspaceId} />
        <EventsSection retro={data} />
      </Stack>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-control border border-hairline px-3 py-2.5">
      <span className="t-label text-mute">{label}</span>
      <span className="font-mono text-lg text-ink tabular-nums">{value}</span>
    </div>
  );
}

function ProductsSection({ retro }: { retro: RetroDetail }) {
  return (
    <Section title="Products" description="Measured by Factoree over the runs this retro read, beside the session of each product.">
      {retro.sessions.length === 0 ? <Empty>No product session yet.</Empty> : null}
      <ul className="-my-2 divide-y divide-hairline">
        {retro.sessions.map((session) => (
          <li key={session.productId} className="flex flex-col gap-3 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-ink">{session.productName}</span>
              <Badge tone={session.status === "finished" ? "success" : session.status === "failed" ? "danger" : "neutral"}>
                {session.status}
              </Badge>
              <span className="t-hint">
                {session.runCount} {session.runCount === 1 ? "run" : "runs"} read
              </span>
            </div>
            {session.metrics ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="First-pass rate" value={percent(session.metrics.firstPassRate)} />
                <Stat label="Repairs per run" value={decimal(session.metrics.repairsPerRun)} />
                <Stat label="Hung sessions" value={String(session.metrics.hungSessions)} />
                <Stat label="Cost per run" value={formatCost(session.metrics.costPerRun)} />
              </div>
            ) : (
              <p className="t-hint">No measured numbers: the session read no run.</p>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="t-label text-mute">Agent</dt>
              <dd className="t-value min-w-0 break-all text-body">
                {[session.runner, session.model, session.effort].filter(Boolean).join(" · ") || "—"}
              </dd>
              <dt className="t-label text-mute">Outcome</dt>
              <dd className="t-value min-w-0 break-all text-body">{session.outcome ?? "—"}</dd>
              <dt className="t-label text-mute">Cost</dt>
              <dd className="t-value min-w-0 text-body">
                {formatCost(session.costUsd)} · {formatDuration(session.durationMs)}
              </dd>
            </dl>
            {session.failureMessage ? <p className="text-xs text-danger">{session.failureMessage}</p> : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function EventsSection({ retro }: { retro: RetroDetail }) {
  const productName = new Map(retro.sessions.map((session) => [session.productId, session.productName]));
  return (
    <Section title="Events" description="Each fault or decision of the retro, such as a query that failed or a finding Factoree dropped.">
      {retro.events.length === 0 ? <Empty>No event.</Empty> : null}
      <ul className="-my-2 divide-y divide-hairline">
        {retro.events.map((event, index) => (
          <li key={index} className="flex flex-col gap-1 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="t-value text-ink">{event.kind}</span>
              {event.productId ? <span className="t-hint">{productName.get(event.productId) ?? event.productId}</span> : null}
              {event.at ? <span className="t-hint ml-auto font-mono tabular-nums">{formatDate(event.at)}</span> : null}
            </div>
            <p className="break-words text-sm text-body">{event.message}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function FindingsSection({
  retro,
  linearWorkspaceId,
  canEdit,
}: {
  retro: RetroDetail;
  linearWorkspaceId: string;
  canEdit: boolean;
}) {
  return (
    <Section
      title="Findings"
      description="Each finding cites the runs, the signal results or the web results that show it. Factoree dropped every finding with a citation outside this retro."
    >
      {retro.findings.length === 0 ? (
        <Empty>{retro.status === "running" ? "No finding yet." : "This retro proposed no finding."}</Empty>
      ) : null}
      <ul className="-my-2 divide-y divide-hairline">
        {retro.findings.map((finding) => (
          <FindingItem
            key={finding.id}
            finding={finding}
            retro={retro}
            linearWorkspaceId={linearWorkspaceId}
            canEdit={canEdit}
          />
        ))}
      </ul>
    </Section>
  );
}

function FindingItem({
  finding,
  retro,
  linearWorkspaceId,
  canEdit,
}: {
  finding: Finding;
  retro: RetroDetail;
  linearWorkspaceId: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const key = getRetroQueryKey({ path: { id: retro.id }, query: { linearWorkspaceId } });
  const replace = (next: Finding) =>
    qc.setQueryData<RetroDetail>(key, (old) =>
      old ? { ...old, findings: old.findings.map((entry) => (entry.id === next.id ? next : entry)) } : old,
    );
  const create = useMutation({
    mutationFn: async () =>
      (await createRetroFindingIssue({ path: { id: finding.id }, body: { linearWorkspaceId }, throwOnError: true })).data,
    onSuccess: replace,
    onError: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const dismiss = useMutation({
    mutationFn: async () =>
      (await dismissRetroFinding({ path: { id: finding.id }, body: { linearWorkspaceId }, throwOnError: true })).data,
    onSuccess: replace,
    onError: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const results = new Map(retro.signalResults.map((result) => [result.id, result]));
  const webResults = new Map(retro.webResults.map((result) => [result.id, result]));
  const idea = finding.kind === "idea";
  // docs/specs/retro-web-research.md. An idea with no cited analytics result rests on web results alone.
  const webOnly = idea && !finding.signalResultIds.some((id) => results.get(id)?.sourceKind === "analytics");

  return (
    <li className="flex min-w-0 flex-col gap-3 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={KIND_TONE[finding.kind]}>{finding.kind}</Badge>
        <Badge tone={finding.status === "created" ? "success" : "neutral"}>
          {FINDING_STATUS_LABEL[finding.status]}
        </Badge>
        {webOnly ? <Badge tone="warning">web only</Badge> : null}
        <span className="t-hint">{finding.productName}</span>
      </div>
      <p className="text-[15px] font-semibold break-words text-ink">{finding.title}</p>
      <Markdown source={finding.description} />
      <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        {finding.runIds.length > 0 ? (
          <>
            <dt className="t-label text-mute">Runs</dt>
            <dd className="flex min-w-0 flex-wrap gap-x-2 gap-y-1">
              {finding.runIds.map((runId) => (
                <Link key={runId} to="/runs/$runId" params={{ runId }} search={{ ws: linearWorkspaceId }} className="link font-mono">
                  {runId.slice(0, 8)}
                </Link>
              ))}
            </dd>
          </>
        ) : null}
        {finding.signalResultIds.length > 0 ? (
          <>
            <dt className="t-label text-mute">Signal results</dt>
            <dd className="flex min-w-0 flex-wrap gap-x-2 gap-y-1">
              {finding.signalResultIds.map((resultId) => {
                const result = results.get(resultId);
                return (
                  <Link
                    key={resultId}
                    to="/retro/signal-results/$resultId"
                    params={{ resultId }}
                    search={{ ws: linearWorkspaceId }}
                    className="link font-mono break-all"
                  >
                    {result ? `${result.sourceName}/${result.queryName}` : resultId.slice(0, 8)}
                    {result?.live ? " (live)" : ""}
                  </Link>
                );
              })}
            </dd>
          </>
        ) : null}
        {finding.webResultIds.length > 0 ? (
          <>
            <dt className="t-label text-mute">Web results</dt>
            <dd className="flex min-w-0 flex-col gap-1">
              {finding.webResultIds.map((resultId) => {
                const result = webResults.get(resultId);
                return (
                  <Link
                    key={resultId}
                    to="/retro/web-results/$resultId"
                    params={{ resultId }}
                    search={{ ws: linearWorkspaceId }}
                    className="link min-w-0 break-all"
                  >
                    {result ? webResultLabel(result) : resultId.slice(0, 8)}
                  </Link>
                );
              })}
            </dd>
          </>
        ) : null}
        {finding.repositories.length > 0 ? (
          <>
            <dt className="t-label text-mute">Repositories</dt>
            <dd className="t-value min-w-0 break-all text-body">{finding.repositories.join(", ")}</dd>
          </>
        ) : null}
      </dl>

      {finding.status === "created" ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-body">
          Linear issue
          {finding.linearIssueUrl ? (
            <a className="link inline-flex items-center gap-1 font-mono" href={finding.linearIssueUrl} target="_blank" rel="noreferrer">
              {finding.linearIssueIdentifier ?? "open"} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          ) : (
            <span className="font-mono text-ink">{finding.linearIssueIdentifier ?? "—"}</span>
          )}
          {idea ? <span className="t-hint">Not delegated. A human delegates it in Linear.</span> : null}
        </p>
      ) : null}
      {finding.status === "dismissed" ? (
        <p className="t-hint">
          Dismissed{finding.decidedBy ? ` by ${finding.decidedBy}` : ""}
          {finding.decidedAt ? `, ${formatDate(finding.decidedAt)}` : ""}.
        </p>
      ) : null}
      {finding.status === "already_proposed" ? (
        <p className="t-hint">
          An open finding of this product has the same title. Decide that one
          {finding.duplicateOfRetroId ? (
            <>
              {" in "}
              <Link to="/retro/$retroId" params={{ retroId: finding.duplicateOfRetroId }} search={{ ws: linearWorkspaceId }} className="link">
                its retro
              </Link>
            </>
          ) : null}
          .
        </p>
      ) : null}

      {finding.status === "proposed" && canEdit ? (
        <div className="flex flex-col gap-2">
          <p className="t-hint">
            {idea
              ? "Factoree creates the issue in Linear and does not delegate it. A human edits it and delegates it."
              : "Factoree creates the issue in the product's Linear team and delegates it to Factoree, so a run makes the change."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" mutation={create} disabled={dismiss.isPending} onClick={() => create.mutate()}>
              {idea ? "Create issue, not delegated" : "Create issue"}
            </Button>
            <Button size="sm" variant="ghost" mutation={dismiss} disabled={create.isPending} onClick={() => dismiss.mutate()}>
              Dismiss
            </Button>
          </div>
          <ErrorAlert error={create.error} title="The issue was not created" />
          <ErrorAlert error={dismiss.error} />
        </div>
      ) : null}
    </li>
  );
}

/** docs/specs/retro-web-research.md. Every signal result of the retro: the operator queries and the live calls. */
function SignalResultsSection({ retro, linearWorkspaceId }: { retro: RetroDetail; linearWorkspaceId: string }) {
  const productName = new Map(retro.sessions.map((session) => [session.productId, session.productName]));
  return (
    <Section
      title="Signal results"
      description="What the retro agent read from the signal sources, redacted. A live result is a tool call the agent made during the session."
    >
      {retro.signalResults.length === 0 ? <Empty>No signal result.</Empty> : null}
      <ul className="-my-2 divide-y divide-hairline">
        {retro.signalResults.map((result) => (
          <li key={result.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-2.5">
            <Link
              to="/retro/signal-results/$resultId"
              params={{ resultId: result.id }}
              search={{ ws: linearWorkspaceId }}
              className="link min-w-0 font-mono text-sm break-all"
            >
              {result.sourceName}/{result.queryName}
            </Link>
            <Badge>{result.sourceKind}</Badge>
            {result.live ? <Badge tone="accent">live</Badge> : null}
            <span className="t-hint">{productName.get(result.productId) ?? result.productId}</span>
            <span className="t-hint ml-auto font-mono tabular-nums">{formatBytes(result.bytes)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * docs/specs/retro-web-research.md. The searches and pages of the retro, by product. The text is
 * untrusted web content, so the list shows only titles and URLs, and each links to its stored copy.
 */
function WebResearchSection({ retro, linearWorkspaceId }: { retro: RetroDetail; linearWorkspaceId: string }) {
  const products = retro.sessions
    .map((session) => ({ id: session.productId, name: session.productName }))
    .filter((product) => retro.webResults.some((result) => result.productId === product.id));
  // A result of a product with no session still shows.
  for (const result of retro.webResults) {
    if (!products.some((product) => product.id === result.productId)) products.push({ id: result.productId, name: result.productId });
  }
  return (
    <Section
      title="Web research"
      description="The searches the retro agent made and the pages it read, through Factoree. Factoree deletes them after the product's retro data retention."
    >
      {retro.webResults.length === 0 ? <Empty>No web research.</Empty> : null}
      <div className="flex flex-col gap-5">
        {products.map((product) => {
          const own = retro.webResults.filter((result) => result.productId === product.id);
          const searches = new Map<string, WebResultRef[]>();
          for (const result of own.filter((entry) => entry.kind === "search")) {
            const query = result.query ?? "";
            searches.set(query, [...(searches.get(query) ?? []), result]);
          }
          const pages = own.filter((result) => result.kind === "page");
          return (
            <div key={product.id} className="flex min-w-0 flex-col gap-3">
              <p className="text-sm font-medium text-ink">{product.name}</p>
              {searches.size > 0 ? (
                <div className="flex min-w-0 flex-col gap-3">
                  <p className="t-label text-mute">
                    {searches.size} {searches.size === 1 ? "search" : "searches"}
                  </p>
                  {[...searches].map(([query, hits]) => (
                    <div key={query} className="flex min-w-0 flex-col gap-1.5 rounded-control border border-hairline p-3">
                      <p className="t-value break-words text-ink">{query || "—"}</p>
                      <ul className="flex min-w-0 flex-col gap-1.5">
                        {hits.map((hit) => (
                          <WebResultRow key={hit.id} result={hit} linearWorkspaceId={linearWorkspaceId} />
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : null}
              {pages.length > 0 ? (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <p className="t-label text-mute">
                    {pages.length} {pages.length === 1 ? "page" : "pages"} read
                  </p>
                  <ul className="flex min-w-0 flex-col gap-1.5">
                    {pages.map((page) => (
                      <WebResultRow key={page.id} result={page} linearWorkspaceId={linearWorkspaceId} />
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function WebResultRow({ result, linearWorkspaceId }: { result: WebResultRef; linearWorkspaceId: string }) {
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <Link
        to="/retro/web-results/$resultId"
        params={{ resultId: result.id }}
        search={{ ws: linearWorkspaceId }}
        className="link min-w-0 text-sm break-words"
      >
        {webResultLabel(result)}
      </Link>
      <span className="flex min-w-0 flex-wrap gap-x-2 text-xs text-mute">
        <span className="min-w-0 font-mono break-all">{result.url}</span>
        {result.publishedDate ? <span>{formatDay(result.publishedDate)}</span> : null}
        <span className="font-mono tabular-nums">{formatBytes(result.bytes)}</span>
      </span>
    </li>
  );
}
