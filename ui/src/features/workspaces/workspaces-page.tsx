import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { listWorkspacesOptions } from "@/api/@tanstack/react-query.gen";
import { startLinearInstall } from "@/api/sdk.gen";
import { Button } from "@/components/button";
import { Alert, Badge, Empty, ErrorAlert, PageHeader, SkeletonTable, TableCard } from "@/components/layout";
import { useMe } from "@/lib/session";
import { formatDate } from "@/lib/utils";

export function WorkspacesPage({ linearError }: { linearError?: string }) {
  const me = useMe();
  const workspaces = useQuery(listWorkspacesOptions());
  const install = useMutation({
    mutationFn: async () => (await startLinearInstall({ throwOnError: true })).data,
    onSuccess: ({ url }) => window.location.assign(url),
  });

  return (
    <>
      <PageHeader
        title="Workspaces"
        description="The Linear workspaces where Factoree is installed, with their GitHub App installations."
        actions={
          me.data?.operatorAdmin ? (
            <Button variant="primary" mutation={install} onClick={() => install.mutate()}>
              Install in another Linear workspace
            </Button>
          ) : null
        }
      />
      {linearError ? (
        <Alert tone="danger" title="The Linear install did not finish" className="mb-4">
          Linear returned: {linearError.replaceAll("_", " ")}
        </Alert>
      ) : null}
      <ErrorAlert error={install.error} className="mb-4" />
      {workspaces.isPending ? <SkeletonTable columns={5} rows={2} label="Loading the workspaces" /> : null}
      <ErrorAlert error={workspaces.error} title="The workspaces did not load" />
      {workspaces.data?.length === 0 ? (
        <div className="card">
          <Empty>No workspace yet.</Empty>
        </div>
      ) : null}
      {workspaces.data && workspaces.data.length > 0 ? (
        <TableCard>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Workspace</th>
                <th scope="col">Your role</th>
                <th scope="col">Linear app</th>
                <th scope="col">GitHub installations</th>
                <th scope="col" className="text-right">
                  Products
                </th>
              </tr>
            </thead>
            <tbody className="stagger">
              {workspaces.data.map((w) => (
                <tr key={w.tenantId}>
                  <td>
                    <div className="text-ink">{w.name}</div>
                    <div className="font-mono text-xs text-mute">{w.linearWorkspaceId}</div>
                  </td>
                  <td>{w.admin ? <Badge>admin</Badge> : <Badge>member</Badge>}</td>
                  <td>
                    {w.linearInstallation ? (
                      <div className="flex flex-col items-start gap-1">
                        <Badge tone="success">installed</Badge>
                        <div className="t-hint">
                          {w.linearInstallation.expiresAt
                            ? `Token expires ${formatDate(w.linearInstallation.expiresAt)}${w.linearInstallation.refreshable ? ", refreshable" : ""}`
                            : "Token does not expire"}
                        </div>
                      </div>
                    ) : (
                      <Badge tone="warning">not installed</Badge>
                    )}
                  </td>
                  <td>
                    {w.githubInstallations.length > 0 ? (
                      <ul className="space-y-0.5">
                        {w.githubInstallations.map((g) => (
                          <li key={g.githubInstallationId} className="whitespace-nowrap">
                            <span className="text-ink">{g.accountLogin}</span>{" "}
                            <span className="font-mono text-xs text-mute">#{g.githubInstallationId}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-mute">None</span>
                    )}
                  </td>
                  <td className="text-right">
                    <Link to="/products" search={{ ws: w.linearWorkspaceId }} className="link t-value">
                      {w.productCount}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      ) : null}
    </>
  );
}
