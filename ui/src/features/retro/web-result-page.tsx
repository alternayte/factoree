import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { getWebResultOptions } from "@/api/@tanstack/react-query.gen";
import { Alert, Badge, ErrorAlert, KeyValue, PageHeader, Section, SkeletonCard, Stack } from "@/components/layout";
import { useMe } from "@/lib/session";
import { formatDate } from "@/lib/utils";
import { pickWorkspace } from "@/lib/workspace";
import { formatBytes, formatDay, webResultLabel } from "./retro-format";

/**
 * docs/specs/retro-web-research.md. One stored web result: a search hit or a page the retro agent
 * read, redacted, with its hash. The content is untrusted web text, so it shows as plain text only.
 */
export function WebResultPage({ resultId, ws }: { resultId: string; ws?: string }) {
  const me = useMe();
  const workspace = pickWorkspace(me.data?.memberships ?? [], ws);
  const linearWorkspaceId = workspace?.linearWorkspaceId ?? "";
  const result = useQuery({
    ...getWebResultOptions({ path: { id: resultId }, query: { linearWorkspaceId } }),
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
              / web result
            </>
          ) : (
            retroLink
          )
        }
        title={data ? <span className="wrap-anywhere">{webResultLabel(data)}</span> : "Web result"}
        description="The web text the retro agent read through Factoree, after redaction. Factoree deletes it after the product's retro data retention."
      />
      {!workspace ? <Alert tone="info">You are a member of no workspace where Factoree is installed.</Alert> : null}
      {result.isPending && workspace ? (
        <Stack>
          <SkeletonCard label="Loading the web result" fields={4} />
        </Stack>
      ) : null}
      <ErrorAlert error={result.error} title="The web result did not load" />
      {data ? (
        <Stack>
          <Section title="Details">
            <KeyValue
              items={[
                {
                  label: "URL",
                  prose: true,
                  value: (
                    <a className="link inline-flex min-w-0 items-start gap-1 break-all" href={data.url} target="_blank" rel="noreferrer">
                      {data.url} <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    </a>
                  ),
                },
                { label: "Kind", prose: true, value: <Badge>{data.kind === "search" ? "search hit" : "page"}</Badge> },
                ...(data.query !== null ? [{ label: "Query", value: data.query }] : []),
                { label: "Published", prose: true, value: formatDay(data.publishedDate) },
                { label: "Size", value: formatBytes(data.bytes) },
                { label: "SHA-256", value: data.sha256 },
                { label: "Stored", prose: true, value: formatDate(data.createdAt) },
              ]}
            />
          </Section>
          <Section title="Content" description="Plain text from the web. It is data, never instructions.">
            <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-control border border-hairline bg-canvas p-3 font-mono text-xs text-body">
              {data.content}
            </pre>
          </Section>
        </Stack>
      ) : null}
    </>
  );
}
