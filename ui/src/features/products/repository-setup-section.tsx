import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getProductQueryKey, listRepositorySetupsOptions, listRepositorySetupsQueryKey } from "@/api/@tanstack/react-query.gen";
import { startRepositorySetups, updateProduct } from "@/api/sdk.gen";
import type { ListRepositorySetupsResponse } from "@/api/types.gen";
import { Button } from "@/components/button";
import { Input } from "@/components/form";
import { Badge, Empty, ErrorAlert, Section, SkeletonRows } from "@/components/layout";
import { formatDate } from "@/lib/utils";

type Repository = ListRepositorySetupsResponse[number];
type Setup = NonNullable<Repository["setup"]>;

const ACTIVE: ReadonlyArray<Setup["status"]> = ["queued", "running"];

const STATUS: Record<Setup["status"], { tone: "neutral" | "success" | "warning" | "danger"; label: string }> = {
  queued: { tone: "neutral", label: "queued" },
  running: { tone: "neutral", label: "running" },
  proposed: { tone: "success", label: "pull request open" },
  partial: { tone: "warning", label: "partial pull request" },
  failed: { tone: "danger", label: "failed" },
  merged: { tone: "success", label: "merged" },
  unchanged: { tone: "success", label: "no change" },
};

/**
 * One line that says where a repository stands. docs/specs/setup-app-change-issues.md: a
 * registered repository takes issues, so it reads active whatever its latest setup says.
 */
function State({ repository }: { repository: Repository }) {
  if (repository.needsSetupReason) return <Badge tone="danger">needs setup</Badge>;
  const setup = repository.setup;
  if (repository.registered) {
    const running = setup !== null && ACTIVE.includes(setup.status);
    const open = setup !== null && (setup.status === "proposed" || setup.status === "partial") && setup.pullRequestUrl !== null;
    return (
      <span className="flex flex-col items-start gap-1">
        <Badge tone="success">active</Badge>
        {running ? <span className="text-xs text-mute">setup {setup.status}</span> : null}
        {open ? (
          <a className="link text-xs" href={setup.pullRequestUrl!} target="_blank" rel="noreferrer">
            setup pull request open
          </a>
        ) : null}
      </span>
    );
  }
  if (setup) {
    const status = STATUS[setup.status];
    return <Badge tone={status.tone}>{status.label}</Badge>;
  }
  return <Badge tone="neutral">no config</Badge>;
}

/**
 * docs/specs/repository-setup-and-services.md. The repositories the GitHub App can read for this
 * product. A setup run writes and proves `.factoree/config.yaml` and opens a pull request. Nothing
 * starts a setup by itself.
 */
export function RepositorySetupSection({
  productId,
  linearWorkspaceId,
  allowedDomains,
  canEdit,
}: {
  productId: string;
  linearWorkspaceId: string;
  allowedDomains: string[];
  canEdit: boolean;
}) {
  const client = useQueryClient();
  const options = listRepositorySetupsOptions({ path: { id: productId }, query: { linearWorkspaceId } });
  const repositories = useQuery({
    ...options,
    // A running setup changes its row, so the list refreshes while one runs.
    refetchInterval: (query) => (query.state.data?.some((repository) => repository.setup && ACTIVE.includes(repository.setup.status)) ? 10_000 : false),
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const refresh = () =>
    client.invalidateQueries({ queryKey: listRepositorySetupsQueryKey({ path: { id: productId }, query: { linearWorkspaceId } }) });

  const start = useMutation({
    mutationFn: async (names: string[]) =>
      startRepositorySetups({ path: { id: productId }, body: { linearWorkspaceId, repositories: names }, throwOnError: true }),
    onSuccess: () => {
      setSelected([]);
      void refresh();
    },
  });

  // The one manual step of a setup: a host outside the ecosystem host list goes on the product
  // allow list once, and the setup runs again.
  const allowHost = useMutation({
    mutationFn: async ({ host }: { host: string; repository: string }) =>
      updateProduct({
        path: { id: productId },
        query: { linearWorkspaceId },
        body: { allowedDomains: [...new Set([...allowedDomains, host])] },
        throwOnError: true,
      }),
    onSuccess: async (_result, { repository }) => {
      await client.invalidateQueries({ queryKey: getProductQueryKey({ path: { id: productId }, query: { linearWorkspaceId } }) });
      start.mutate([repository]);
    },
  });

  const all = repositories.data ?? [];
  const needle = filter.trim().toLowerCase();
  const rows = needle === "" ? all : all.filter((repository) => repository.fullName.toLowerCase().includes(needle));
  const starting = (name: string) => start.isPending && (start.variables ?? []).includes(name);
  const startable = (repository: Repository) => canEdit && !(repository.setup && ACTIVE.includes(repository.setup.status));
  const toggle = (name: string) => setSelected((current) => (current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name]));

  return (
    <Section
      title="Repositories"
      description="The repositories the GitHub App can read. A setup run writes and proves the Factoree config, then opens a pull request with the parts that passed."
      flush={all.length > 0}
      actions={
        canEdit && selected.length > 0 ? (
          <Button onClick={() => start.mutate(selected)} mutation={start}>
            Set up {selected.length} selected
          </Button>
        ) : undefined
      }
    >
      {repositories.isPending ? <SkeletonRows label="Loading the repositories" /> : null}
      <ErrorAlert error={repositories.error} title="The repositories did not load" />
      <ErrorAlert error={start.error} title="The setup did not start" />
      <ErrorAlert error={allowHost.error} title="The host was not added" />
      {repositories.data && all.length === 0 ? <Empty>The GitHub App can read no repository for this product.</Empty> : null}
      {all.length > 0 ? (
        <div className="border-b border-hairline px-4 py-3">
          <Input
            type="search"
            aria-label="Filter repositories"
            placeholder="Filter repositories"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      ) : null}
      {all.length > 0 && rows.length === 0 ? <Empty>No repository matches “{filter.trim()}”.</Empty> : null}
      {rows.length > 0 ? (
        <div className="max-h-96 overflow-auto">
          <table className="table">
            <thead className="sticky top-0 z-[1] bg-canvas">
              <tr>
                <th aria-label="Select" />
                <th>Repository</th>
                <th>State</th>
                <th>Last setup</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((repository) => (
                <RepositoryRow
                  key={repository.fullName}
                  repository={repository}
                  selected={selected.includes(repository.fullName)}
                  onToggle={() => toggle(repository.fullName)}
                  startable={startable(repository)}
                  onStart={() => start.mutate([repository.fullName])}
                  open={open === repository.fullName}
                  onOpen={() => setOpen(open === repository.fullName ? null : repository.fullName)}
                  onAllowHost={(host) => allowHost.mutate({ host, repository: repository.fullName })}
                  busy={start.isPending || allowHost.isPending}
                  starting={starting(repository.fullName)}
                  addingHost={allowHost.isPending && allowHost.variables?.repository === repository.fullName ? allowHost.variables.host : null}
                  canEdit={canEdit}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Section>
  );
}

function RepositoryRow(props: {
  repository: Repository;
  selected: boolean;
  onToggle: () => void;
  startable: boolean;
  onStart: () => void;
  open: boolean;
  onOpen: () => void;
  onAllowHost: (host: string) => void;
  busy: boolean;
  /** This row's setup start is in flight, so its button shows the spinner. */
  starting: boolean;
  /** The host this row is adding to the allow list, or null. */
  addingHost: string | null;
  canEdit: boolean;
}) {
  const { repository } = props;
  const setup = repository.setup;
  const again = repository.registered || setup !== null;
  return (
    <>
      <tr>
        <td>
          <input
            type="checkbox"
            aria-label={`Select ${repository.fullName}`}
            checked={props.selected}
            disabled={!props.startable}
            onChange={props.onToggle}
          />
        </td>
        <td className="t-value">
          <span className="block text-ink">{repository.fullName}</span>
          {repository.needsSetupReason ? <span className="block text-mute">{repository.needsSetupReason}</span> : null}
        </td>
        <td>
          <State repository={repository} />
        </td>
        <td className="whitespace-nowrap text-body">
          {setup ? (
            <>
              <span className="block">{formatDate(setup.createdAt)}</span>
              {setup.pullRequestUrl ? (
                <a className="link" href={setup.pullRequestUrl} target="_blank" rel="noreferrer">
                  Pull request
                </a>
              ) : null}
            </>
          ) : (
            <span className="text-mute">never</span>
          )}
        </td>
        <td className="whitespace-nowrap text-right">
          {setup?.report || setup?.failureMessage ? (
            <Button variant="ghost" onClick={props.onOpen}>
              {props.open ? "Hide report" : "Report"}
            </Button>
          ) : null}
          {props.startable ? (
            <Button variant="secondary" onClick={props.onStart} disabled={props.busy && !props.starting} pending={props.starting}>
              {again ? "Run setup again" : "Set up"}
            </Button>
          ) : null}
        </td>
      </tr>
      {props.open && setup ? (
        <tr>
          <td colSpan={5}>
            {setup.failureMessage ? <p className="text-body">{setup.failureMessage}</p> : null}
            {setup.deniedHosts.length > 0 && props.canEdit ? (
              <div className="my-2 flex flex-wrap gap-2">
                {setup.deniedHosts.map((host) => (
                  <Button
                    key={host}
                    variant="secondary"
                    onClick={() => props.onAllowHost(host)}
                    disabled={props.busy && props.addingHost !== host}
                    pending={props.addingHost === host}
                  >
                    Add {host} to product allow list
                  </Button>
                ))}
              </div>
            ) : null}
            {setup.report ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-body">{setup.report}</pre> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}
