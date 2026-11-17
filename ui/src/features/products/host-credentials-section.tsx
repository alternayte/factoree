import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listHostCredentialsOptions, listHostCredentialsQueryKey } from "@/api/@tanstack/react-query.gen";
import { putHostCredentials } from "@/api/sdk.gen";
import type { ListHostCredentialsResponse, PutHostCredentialsData } from "@/api/types.gen";
import { Button } from "@/components/button";
import { Confirm } from "@/components/confirm";
import { Field, Input, Select, Textarea } from "@/components/form";
import { Badge, Empty, ErrorAlert, Section, SkeletonRows } from "@/components/layout";

type Credential = ListHostCredentialsResponse["credentials"][number];
type Kind = Credential["kind"];
type CredentialInput = PutHostCredentialsData["body"]["credentials"][number];

const KINDS: { value: Kind; label: string; hint: string }[] = [
  {
    value: "registry",
    label: "Registry login",
    hint: "A container registry login, such as ghcr.io or an Azure Container Registry. Factoree checks it on save.",
  },
  {
    value: "header",
    label: "Header",
    hint: "One header for a package feed, such as npm.pkg.github.com or nuget.pkg.github.com. Factoree sends the secret as you enter it.",
  },
  {
    value: "github",
    label: "GitHub git access",
    hint: "A read-only GitHub App token for git fetches of the listed repositories, such as private Go modules.",
  },
];

const kindLabel = (kind: Kind) => KINDS.find((k) => k.value === kind)?.label ?? kind;

const lines = (text: string) =>
  text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** The stored record as a save input that keeps its stored secret. */
const inputOf = (credential: Credential): CredentialInput => ({
  kind: credential.kind,
  host: credential.host,
  username: credential.username,
  headerName: credential.headerName,
  pathPrefix: credential.pathPrefix,
  redirectHosts: credential.redirectHosts,
  repositories: credential.repositories,
});

/** docs/specs/host-credentials.md. The private hosts that every sandbox of the product reaches. */
export function HostCredentialsSection({
  productId,
  linearWorkspaceId,
  canEdit,
}: {
  productId: string;
  linearWorkspaceId: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const options = { path: { id: productId }, query: { linearWorkspaceId } };
  const list = useQuery(listHostCredentialsOptions(options));
  const [editing, setEditing] = useState<Credential | "new" | null>(null);
  const [removing, setRemoving] = useState<Credential | null>(null);
  const credentials = list.data?.credentials ?? [];
  const suggestions = list.data?.suggestedRedirectHosts ?? {};

  const save = useMutation({
    mutationFn: async (next: CredentialInput[]) =>
      putHostCredentials({ ...options, body: { credentials: next }, throwOnError: true }),
    onSuccess: (response) => {
      qc.setQueryData(listHostCredentialsQueryKey(options), response.data);
      setEditing(null);
      setRemoving(null);
    },
  });

  return (
    <Section
      title="Host credentials"
      description="Private registries, package feeds and git repositories. The sandbox provider adds each credential outside the sandbox, so no agent, script or file holds it."
      actions={
        canEdit && editing === null && credentials.length < 8 ? (
          <Button size="sm" onClick={() => setEditing("new")}>
            Add credential
          </Button>
        ) : null
      }
    >
      <p className="t-hint mb-3">
        Use read-only tokens. Kiln sends a credential on GET and HEAD only, so a publish leaves with no key. E2B cannot
        narrow by method, so on E2B a write-capable token can publish.
      </p>
      {editing !== null ? (
        <CredentialForm
          key={editing === "new" ? "new" : editing.host}
          existing={editing === "new" ? null : editing}
          suggestions={suggestions}
          mutation={save}
          onSubmit={(input) => {
            const rest = credentials.filter((credential) => editing === "new" || credential.host !== editing.host).map(inputOf);
            const index = editing === "new" ? -1 : credentials.findIndex((credential) => credential.host === editing.host);
            const next = [...rest];
            next.splice(index < 0 ? next.length : index, 0, input);
            save.mutate(next);
          }}
          onCancel={() => {
            save.reset();
            setEditing(null);
          }}
        />
      ) : null}
      {list.isPending ? <SkeletonRows label="Loading the host credentials" /> : null}
      <ErrorAlert error={list.error} title="The host credentials did not load" />
      {editing === null ? <ErrorAlert error={save.error} /> : null}
      {list.data && credentials.length === 0 && editing === null ? <Empty>No host credentials.</Empty> : null}
      {credentials.length > 0 ? (
        <ul className="stagger -my-2 divide-y divide-hairline">
          {credentials.map((credential) => (
            <li key={credential.host} className="flex flex-col gap-1 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="t-value min-w-0 flex-1 basis-full break-all text-ink sm:basis-0">{credential.host}</span>
                <Badge>{kindLabel(credential.kind)}</Badge>
                {credential.kind === "github" ? null : credential.hasSecret ? (
                  <Badge tone="success">stored</Badge>
                ) : (
                  <Badge tone="warning">no secret</Badge>
                )}
                {canEdit ? (
                  <span className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(credential)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setRemoving(credential)}>
                      Remove
                    </Button>
                  </span>
                ) : null}
              </div>
              <CredentialDetail credential={credential} />
            </li>
          ))}
        </ul>
      ) : null}
      <Confirm
        open={removing !== null}
        title={`Remove the host credential for ${removing?.host ?? ""}?`}
        confirmLabel="Remove credential"
        mutation={save}
        onCancel={() => setRemoving(null)}
        onConfirm={() =>
          removing &&
          save.mutate(credentials.filter((credential) => credential.host !== removing.host).map(inputOf))
        }
      >
        Sandboxes that start after this no longer reach the host. Factoree deletes the stored secret.
      </Confirm>
    </Section>
  );
}

function CredentialDetail({ credential }: { credential: Credential }) {
  const parts: string[] = [];
  if (credential.kind === "registry" && credential.username) parts.push(`user ${credential.username}`);
  if (credential.kind === "registry" && credential.realmHost) parts.push(`token service ${credential.realmHost}`);
  if (credential.kind === "header" && credential.headerName) parts.push(`header ${credential.headerName}`);
  if (credential.pathPrefix) parts.push(`path ${credential.pathPrefix}`);
  if (credential.kind === "github") parts.push(`${credential.repositories.length} listed repositories and the product repositories`);
  if (credential.redirectHosts.length > 0) parts.push(`redirects to ${credential.redirectHosts.join(", ")}`);
  return parts.length === 0 ? null : <span className="t-hint break-all">{parts.join(" · ")}</span>;
}

function CredentialForm({
  existing,
  suggestions,
  mutation,
  onSubmit,
  onCancel,
}: {
  existing: Credential | null;
  suggestions: Record<string, string[]>;
  mutation: ReturnType<typeof useMutation<unknown, Error, CredentialInput[]>>;
  onSubmit: (input: CredentialInput) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<Kind>(existing?.kind ?? "header");
  const [host, setHost] = useState(existing?.kind === "github" ? "" : (existing?.host ?? ""));
  const [username, setUsername] = useState(existing?.username ?? "");
  const [headerName, setHeaderName] = useState(existing?.headerName ?? "Authorization");
  const [pathPrefix, setPathPrefix] = useState(existing?.pathPrefix ?? "");
  const [secret, setSecret] = useState("");
  const [redirects, setRedirects] = useState((existing?.redirectHosts ?? []).join("\n"));
  const [repositories, setRepositories] = useState((existing?.repositories ?? []).join("\n"));
  const suggested = suggestions[host.trim().toLowerCase()] ?? [];
  const missingSuggestions = suggested.filter((entry) => !lines(redirects).includes(entry));
  const needsSecret = kind !== "github" && !(existing?.hasSecret && existing.host === host.trim().toLowerCase());

  return (
    <form
      className="enter mb-4 flex flex-col gap-4 rounded-control border border-hairline-strong bg-raised/50 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          kind,
          host: kind === "github" ? "github.com" : host.trim(),
          ...(kind === "registry" ? { username: username.trim() } : {}),
          ...(kind === "header" ? { headerName: headerName.trim(), pathPrefix: pathPrefix.trim() === "" ? null : pathPrefix.trim() } : {}),
          redirectHosts: lines(redirects),
          ...(kind === "github" ? { repositories: lines(repositories) } : {}),
          ...(kind !== "github" && secret !== "" ? { secret } : {}),
        });
      }}
    >
      <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
        <Field label="Kind" hint={KINDS.find((k) => k.value === kind)?.hint}>
          {(props) => (
            <Select {...props} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {kind === "github" ? (
          <Field label="Host" hint="Git over HTTPS to github.com.">
            {(props) => <Input {...props} mono disabled value="github.com" />}
          </Field>
        ) : (
          <Field label="Host" hint="One exact host name, with no wildcard.">
            {(props) => (
              <Input {...props} mono required autoComplete="off" value={host} onChange={(e) => setHost(e.target.value)} />
            )}
          </Field>
        )}
        {kind === "registry" ? (
          <Field label="Username">
            {(props) => (
              <Input {...props} mono required autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
            )}
          </Field>
        ) : null}
        {kind === "header" ? (
          <>
            <Field label="Header name">
              {(props) => (
                <Input {...props} mono required autoComplete="off" value={headerName} onChange={(e) => setHeaderName(e.target.value)} />
              )}
            </Field>
            <Field label="Path prefix" hint="Optional. For example /acme/ for nuget.pkg.github.com/acme. Leave it empty for npm.">
              {(props) => (
                <Input {...props} mono autoComplete="off" value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} />
              )}
            </Field>
          </>
        ) : null}
        {kind !== "github" ? (
          <Field
            label={needsSecret ? "Secret" : "New secret"}
            hint={
              kind === "header"
                ? "The whole header value, such as Bearer <token> or Basic <base64 of user:token>."
                : needsSecret
                  ? undefined
                  : "Leave it empty to keep the stored secret."
            }
          >
            {(props) => (
              <Input
                {...props}
                mono
                required={needsSecret}
                type="password"
                autoComplete="off"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            )}
          </Field>
        ) : null}
        {kind === "github" ? (
          <Field
            label="Repositories"
            hint="owner/name, one per line, at most 50. The product's own repositories are always added."
            className="sm:col-span-2"
          >
            {(props) => (
              <Textarea {...props} rows={4} mono value={repositories} onChange={(e) => setRepositories(e.target.value)} />
            )}
          </Field>
        ) : null}
        <Field
          label="Redirect hosts"
          hint="Hosts a download redirects to, one per line, at most 4. They get no credential."
          className="sm:col-span-2"
          trailing={
            missingSuggestions.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRedirects([...lines(redirects), ...missingSuggestions].join("\n"))}
              >
                Add {missingSuggestions.join(", ")}
              </Button>
            ) : null
          }
        >
          {(props) => <Textarea {...props} rows={2} mono value={redirects} onChange={(e) => setRedirects(e.target.value)} />}
        </Field>
      </div>
      <ErrorAlert error={mutation.error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" mutation={mutation}>
          {existing ? "Save credential" : "Add credential"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
