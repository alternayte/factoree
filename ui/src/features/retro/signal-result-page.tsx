import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getSignalResultOptions } from "@/api/@tanstack/react-query.gen";
import { Alert, Badge, ErrorAlert, KeyValue, PageHeader, Section, SkeletonCard, Stack } from "@/components/layout";
import { useMe } from "@/lib/session";
import { formatDate } from "@/lib/utils";
import { pickWorkspace } from "@/lib/workspace";

/** docs/specs/retro-agent.md. One stored signal result: what the retro agent read, redacted, with its hash. */
export function SignalResultPage({ resultId, ws }: { resultId: string; ws?: string }) {
  const me = useMe();
  const workspace = pickWorkspace(me.data?.memberships ?? [], ws);
  const linearWorkspaceId = workspace?.linearWorkspaceId ?? "";
  const result = useQuery({
    ...getSignalResultOptions({ path: { id: resultId }, query: { linearWorkspaceId } }),
    enabled: Boolean(workspace),
  });
  const retroLink = (
    <Link to="/retro" search={ws ? { ws } : {}} className="hover:text-body">
      retro
    </Link>
  );
  const data = result.data;
  return (
    <>
      <PageHeader
        crumb={
          data ? (
            <>
              {retroLink} /{" "}
              <Link to="/retro/$retroId" params={{ retroId: data.retroId }} search={ws ? { ws } : {}} className="hover:text-body">
                {data.retroId.slice(0, 8)}
              </Link>{" "}
              / signal result
            </>
          ) : (
            retroLink
          )
        }
        title={data ? `${data.sourceName} / ${data.queryName}` : "Signal result"}
        description="The query result the retro agent read, after redaction. Factoree deletes it after the product's retro data retention."
      />
      {!workspace ? <Alert tone="info">You are a member of no workspace where Factoree is installed.</Alert> : null}
      {result.isPending && workspace ? (
        <Stack>
          <SkeletonCard label="Loading the signal result" fields={4} />
        </Stack>
      ) : null}
      <ErrorAlert error={result.error} title="The signal result did not load" />
      {data ? (
        <Stack>
          <Section title="Details">
            <KeyValue
              items={[
                { label: "Source", value: data.sourceName },
                { label: "Kind", prose: true, value: <Badge>{data.sourceKind}</Badge> },
                { label: "Query", value: data.queryName },
                { label: "Size", value: `${data.bytes} bytes` },
                { label: "SHA-256", value: data.sha256 },
                { label: "Stored", prose: true, value: formatDate(data.createdAt) },
              ]}
            />
          </Section>
          <Section title="Content">
            <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-control border border-hairline bg-canvas p-3 font-mono text-xs text-body">
              {data.content}
            </pre>
          </Section>
        </Stack>
      ) : null}
    </>
  );
}
