import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { listProductsOptions } from "@/api/@tanstack/react-query.gen";
import { listRuns } from "@/api/sdk.gen";
import { Button } from "@/components/button";
import { Select } from "@/components/form";
import { Alert, Badge, Empty, ErrorAlert, PageHeader, SkeletonTable, TableCard } from "@/components/layout";
import { useMe } from "@/lib/session";
import { formatDate } from "@/lib/utils";
import { pickWorkspace } from "@/lib/workspace";
import { WorkspacePicker } from "@/features/products/workspace-picker";
import { formatCost, formatDuration, issueIdentifier, STATUS_FILTERS, statusTone } from "./run-format";

export type RunsSearch = { ws?: string; product?: string; status?: string };

export function runsSearch(search: Record<string, unknown>): RunsSearch {
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const ws = text(search.ws);
  const product = text(search.product);
  const status = text(search.status);
  return { ...(ws ? { ws } : {}), ...(product ? { product } : {}), ...(status ? { status } : {}) };
}

/** docs/specs/run-visibility.md. Every run of a workspace, newest first. Read-only. */
export function RunsPage({ search }: { search: RunsSearch }) {
  const me = useMe();
  const memberships = me.data?.memberships ?? [];
  const workspace = pickWorkspace(memberships, search.ws);
  const navigate = useNavigate();
  const linearWorkspaceId = workspace?.linearWorkspaceId ?? "";
  const products = useQuery({
    ...listProductsOptions({ query: { linearWorkspaceId } }),
    enabled: Boolean(workspace),
  });
  const runs = useInfiniteQuery({
    queryKey: ["runs", linearWorkspaceId, search.product ?? null, search.status ?? null],
    enabled: Boolean(workspace),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await listRuns({
          query: {
            linearWorkspaceId,
            ...(search.product ? { productId: search.product } : {}),
            ...(search.status ? { status: search.status } : {}),
            ...(pageParam ? { cursor: pageParam } : {}),
          },
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  if (!workspace) {
    return (
      <>
        <PageHeader title="Runs" />
        <Alert tone="info">You are a member of no workspace where Factoree is installed.</Alert>
      </>
    );
  }

  const filter = (next: Partial<RunsSearch>) =>
    void navigate({ to: "/runs", search: runsSearch({ ...search, ws: linearWorkspaceId, ...next }) });
  const items = runs.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <PageHeader
        title="Runs"
        description="Every run of the workspace, newest first: what it worked on, how it ended, how long it took and what it cost."
      />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <WorkspacePicker memberships={memberships} current={workspace} />
        <Select
          aria-label="Product"
          className="w-auto"
          value={search.product ?? ""}
          onChange={(event) => filter({ product: event.target.value || undefined })}
        >
          <option value="">All products</option>
          {(products.data ?? []).map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Status"
          className="w-auto"
          value={search.status ?? ""}
          onChange={(event) => filter({ status: event.target.value || undefined })}
        >
          <option value="">All statuses</option>
          {STATUS_FILTERS.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </Select>
      </div>
      {runs.isPending ? <SkeletonTable columns={7} label="Loading the runs" /> : null}
      {runs.isError ? <ErrorAlert error={runs.error} title="The runs did not load" /> : null}
      {runs.isSuccess && items.length === 0 ? (
        <div className="card">
          <Empty>No runs match.</Empty>
        </div>
      ) : null}
      {items.length > 0 ? (
        <TableCard>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Work item</th>
                <th scope="col">Product</th>
                <th scope="col">Status</th>
                <th scope="col" className="text-right">
                  Duration
                </th>
                <th scope="col" className="text-right">
                  Cost
                </th>
                <th scope="col" className="text-right">
                  Repairs
                </th>
                <th scope="col">Started</th>
                <th scope="col">Pull request</th>
              </tr>
            </thead>
            <tbody className="stagger">
              {items.map((run) => (
                <tr key={run.id}>
                  <td className="min-w-[240px] max-w-[420px]">
                    <Link
                      to="/runs/$runId"
                      params={{ runId: run.id }}
                      search={{ ws: linearWorkspaceId }}
                      className="link font-medium no-underline hover:underline"
                    >
                      {run.workItemTitle ?? "Untitled run"}
                    </Link>
                    <div className="font-mono text-xs text-mute">{issueIdentifier(run.workItemUrl) ?? run.id.slice(0, 8)}</div>
                  </td>
                  <td className="whitespace-nowrap">{run.productName}</td>
                  <td>
                    <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                    {run.failureReason ? <div className="mt-1 font-mono text-xs text-mute">{run.failureReason}</div> : null}
                  </td>
                  <td className="t-value text-right">
                    {formatDuration(run.durationMs)}
                    {run.waitedMs > 0 ? <div className="mt-1 text-xs text-mute">waited {formatDuration(run.waitedMs)}</div> : null}
                  </td>
                  <td className="t-value text-right">{formatCost(run.costUsd)}</td>
                  <td className="t-value text-right">
                    {run.repairCount}
                    {run.repairLimit === null ? "" : ` of ${run.repairLimit}`}
                  </td>
                  <td className="whitespace-nowrap text-mute">{formatDate(run.createdAt)}</td>
                  <td>
                    {run.pullRequestUrl ? (
                      <a className="link" href={run.pullRequestUrl} target="_blank" rel="noreferrer">
                        #{run.pullRequestUrl.split("/").at(-1)}
                      </a>
                    ) : (
                      <span className="text-mute">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      ) : null}
      {runs.hasNextPage ? (
        <div className="mt-4">
          <Button variant="secondary" onClick={() => void runs.fetchNextPage()} disabled={runs.isFetchingNextPage}>
            {runs.isFetchingNextPage ? "Loading…" : "Load older runs"}
          </Button>
        </div>
      ) : null}
    </>
  );
}
