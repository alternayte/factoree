import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { listRepositorySetupHistoryOptions } from "@/api/@tanstack/react-query.gen";
import type { ListRepositorySetupHistoryResponse } from "@/api/types.gen";
import { Button } from "@/components/button";
import { Alert, Badge, Empty, ErrorAlert, PageHeader, Section, SkeletonRows } from "@/components/layout";
import { formatCost, formatDuration, formatTokens } from "@/features/runs/run-format";
import { useMe } from "@/lib/session";
import { formatDate } from "@/lib/utils";
import { pickWorkspace } from "@/lib/workspace";
import { setupStatus } from "./repository-setup-section";

type Entry = ListRepositorySetupHistoryResponse[number];

/** The Temporal UI page of one setup run. Every setup of a repository shares the workflow id. */
function temporalRunUrl(entry: Entry): string | null {
  return entry.temporalRunId === null
    ? null
    : `/temporal/namespaces/default/workflows/${encodeURIComponent(entry.workflowId)}/${encodeURIComponent(entry.temporalRunId)}/history`;
}

function totalMs(entry: Entry): number | null {
  return entry.endedAt === null ? null : new Date(entry.endedAt).getTime() - new Date(entry.createdAt).getTime();
}

/** How the session ran: skipped, warm, cold, or none. */
function sessionKind(entry: Entry): string {
  if (entry.skippedFromSetupId !== null) return "skipped";
  if (entry.warm === true) return "warm";
  if (entry.warm === false) return "cold";
  return "—";
}

/**
 * docs/specs/setup-speed-and-history.md. Every setup of one repository, newest first, with its
 * time, cost and report, so a cold setup, a warm one and a skipped one compare side by side.
 */
export function SetupHistoryPage({ productId, ws, repository }: { productId: string; ws?: string; repository: string }) {
  const me = useMe();
  const workspace = pickWorkspace(me.data?.memberships ?? [], ws);
  const linearWorkspaceId = workspace?.linearWorkspaceId ?? "";
  const history = useQuery({
    ...listRepositorySetupHistoryOptions({ path: { id: productId }, query: { linearWorkspaceId, repository } }),
    enabled: Boolean(workspace) && repository !== "",
  });
  const [open, setOpen] = useState<string | null>(null);
  const crumb = (
    <Link to="/products/$productId" params={{ productId }} search={ws ? { ws } : {}} className="hover:text-body">
      product
    </Link>
  );
  const entries = history.data ?? [];
  return (
    <div>
      <PageHeader crumb={crumb} title={repository || "Setup history"} description="Every setup run of this repository, newest first." />
      {!workspace ? <Alert tone="info">You are a member of no workspace where Factoree is installed.</Alert> : null}
      <Section title="Setup history" flush={entries.length > 0}>
        {history.isPending && workspace ? <SkeletonRows label="Loading the setup history" /> : null}
        <ErrorAlert error={history.error} title="The setup history did not load" />
        {history.data && entries.length === 0 ? <Empty>This repository has no setup run.</Empty> : null}
        {entries.length > 0 ? (
          <div className="overflow-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Session</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Agent</th>
                  <th className="text-right">Proof</th>
                  <th className="text-right">Cost</th>
                  <th className="text-right">Tokens</th>
                  <th className="text-right">Turns</th>
                  <th className="text-right">Model / tools</th>
                  <th>Links</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const status = setupStatus(entry);
                  const temporal = temporalRunUrl(entry);
                  const session = entry.session;
                  return (
                    <Fragment key={entry.id}>
                      <tr>
                        <td className="whitespace-nowrap text-body">{formatDate(entry.createdAt)}</td>
                        <td>
                          <Badge tone={status.tone}>{status.label}</Badge>
                        </td>
                        <td className="whitespace-nowrap text-body">
                          <span className="block">{sessionKind(entry)}</span>
                          {session ? <span className="block text-xs text-mute">{session.model ?? session.runner}</span> : null}
                        </td>
                        <td className="t-value text-right">{formatDuration(totalMs(entry))}</td>
                        <td className="t-value text-right">{formatDuration(session?.durationMs ?? null)}</td>
                        <td className="t-value text-right">{formatDuration(entry.proofMs)}</td>
                        <td className="t-value text-right">{formatCost(session?.costUsd ?? null)}</td>
                        <td className="t-value text-right">{formatTokens(session?.tokens ?? null)}</td>
                        <td className="t-value text-right">{session?.turns ?? "—"}</td>
                        <td className="t-value whitespace-nowrap text-right">
                          {formatDuration(session?.modelMs ?? null)} / {formatDuration(session?.toolMs ?? null)}
                        </td>
                        <td className="whitespace-nowrap">
                          {entry.pullRequestUrl ? (
                            <a className="link mr-3" href={entry.pullRequestUrl} target="_blank" rel="noreferrer">
                              Pull request
                            </a>
                          ) : null}
                          {temporal ? (
                            <a className="link" href={temporal} target="_blank" rel="noreferrer">
                              Temporal
                            </a>
                          ) : null}
                        </td>
                        <td className="text-right">
                          {entry.report || entry.failureMessage || entry.appChangeIssues.length > 0 ? (
                            <Button variant="ghost" onClick={() => setOpen(open === entry.id ? null : entry.id)}>
                              {open === entry.id ? "Hide report" : "Report"}
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                      {open === entry.id ? (
                        <tr>
                          <td colSpan={12}>
                            <SetupDetail entry={entry} entries={entries} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Section>
    </div>
  );
}

function SetupDetail({ entry, entries }: { entry: Entry; entries: Entry[] }) {
  const source = entry.skippedFromSetupId === null ? null : entries.find((other) => other.id === entry.skippedFromSetupId);
  return (
    <div className="space-y-3">
      {entry.skippedFromSetupId !== null ? (
        <p className="text-body">
          The inputs matched the setup of {source ? formatDate(source.createdAt) : entry.skippedFromSetupId}, so this setup ran no session and copied its report.
        </p>
      ) : null}
      {entry.failureMessage ? <p className="text-body">{entry.failureMessage}</p> : null}
      {entry.appChangeIssues.length > 0 ? (
        <div>
          <h3 className="t-label mb-1">App-change issues</h3>
          <ul className="space-y-1 text-body">
            {entry.appChangeIssues.map((issue) => (
              <li key={issue.identifier}>
                {issue.url ? (
                  <a className="link" href={issue.url} target="_blank" rel="noreferrer">
                    {issue.identifier}
                  </a>
                ) : (
                  <span className="text-ink">{issue.identifier}</span>
                )}{" "}
                <span className="text-mute">{issue.outcome === null ? "open" : issue.outcome === "merged" ? "merged" : "ended, not merged"}</span>
                <span className="block">{issue.changes.join(" ")}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {entry.report ? <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap text-body">{entry.report}</pre> : null}
    </div>
  );
}
