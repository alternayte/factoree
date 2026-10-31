import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import {
  listContextSourcesOptions,
  listContextSourcesQueryKey,
  listProductSecretsOptions,
  listProductSecretsQueryKey,
} from "@/api/@tanstack/react-query.gen";
import { deleteContextSource, putContextSource, putProductSecret, testContextSource } from "@/api/sdk.gen";
import type { ListContextSourcesResponse, PutContextSourceData, TestContextSourceData } from "@/api/types.gen";
import { Button } from "@/components/button";
import { Confirm } from "@/components/confirm";
import { Field, Input, Select } from "@/components/form";
import { Alert, Badge, Empty, ErrorAlert, Section, SkeletonRows } from "@/components/layout";
import { ApiError } from "@/lib/api";
import { formatDate } from "@/lib/utils";

type Source = ListContextSourcesResponse[number];
type Kind = Source["kind"];
type Settings = NonNullable<PutContextSourceData["body"]["settings"]>;
type McpSettings = Extract<Settings, { discoverTool: string }>;
type Authority = NonNullable<McpSettings["authority"]>;

/** SDD §22. The authority classes, highest first inside each domain. */
const AUTHORITIES: { value: Authority; domain: string }[] = [
  { value: "work_item_decision", domain: "product intent" },
  { value: "approved_product_specification", domain: "product intent" },
  { value: "product_documentation", domain: "product intent" },
  { value: "accepted_adr", domain: "architecture intent" },
  { value: "approved_architecture_specification", domain: "architecture intent" },
  { value: "architecture_documentation", domain: "architecture intent" },
  { value: "repository_readme", domain: "architecture intent" },
  { value: "machine_readable_contract", domain: "interface contract" },
  { value: "contract_tests", domain: "interface contract" },
  { value: "api_documentation", domain: "interface contract" },
  { value: "prose_documentation", domain: "interface contract" },
  { value: "source_code", domain: "current implementation" },
  { value: "executable_tests", domain: "current implementation" },
  { value: "runtime_behavior", domain: "current implementation" },
  { value: "declarative_catalog", domain: "system topology" },
  { value: "repository_configuration", domain: "system topology" },
];

const KIND_LABEL: Record<Kind, string> = { mcp: "MCP server", backstage: "Backstage" };

const SOURCE_ID_PATTERN = "[a-z0-9][a-z0-9._:\\-]*";

const isMcp = (settings: Settings): settings is McpSettings => "discoverTool" in settings;

/** The authority of a source. A Backstage catalog is always declarative topology. */
const authorityOf = (source: Source): string =>
  isMcp(source.settings) ? (source.settings.authority ?? "prose_documentation") : "declarative_catalog";

const secretNameFor = (sourceId: string) =>
  `${sourceId.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "CONTEXT_SOURCE"}_TOKEN`;

/** Issue 8. The Backstage catalogs and MCP servers a run of this product reads context from. */
export function ContextSourcesSection({
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
  const sources = useQuery(listContextSourcesOptions(options));
  const [adding, setAdding] = useState<Kind | null>(null);
  const [deleting, setDeleting] = useState<Source | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: listContextSourcesQueryKey(options) });

  const remove = useMutation({
    mutationFn: async (sourceId: string) =>
      deleteContextSource({ path: { id: productId, sourceId }, query: { linearWorkspaceId }, throwOnError: true }),
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });

  return (
    <Section
      title="Context sources"
      description="Backstage catalogs and MCP servers that a run reads context from. Linear and the repositories need no entry."
      actions={
        canEdit && adding === null ? (
          <>
            <Button size="sm" onClick={() => setAdding("mcp")}>
              Add MCP server
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding("backstage")}>
              Add Backstage
            </Button>
          </>
        ) : null
      }
    >
      {adding !== null ? (
        <SourceForm
          key={adding}
          kind={adding}
          productId={productId}
          linearWorkspaceId={linearWorkspaceId}
          takenIds={sources.data?.map((source) => source.sourceId) ?? []}
          onDone={() => {
            setAdding(null);
            void refresh();
          }}
          onCancel={() => setAdding(null)}
        />
      ) : null}
      {sources.isPending ? <SkeletonRows label="Loading the context sources" /> : null}
      <ErrorAlert error={sources.error} title="The context sources did not load" />
      <ErrorAlert error={remove.error} />
      {sources.data?.length === 0 && adding === null ? <Empty>No context source. Runs read Linear and the repositories only.</Empty> : null}
      {sources.data && sources.data.length > 0 ? (
        <ul className="stagger -my-2 divide-y divide-hairline">
          {sources.data.map((source) => (
            <li key={source.sourceId} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="t-value min-w-0 break-all text-ink">{source.sourceId}</span>
                <Badge>{KIND_LABEL[source.kind]}</Badge>
                {source.enabled ? null : <Badge tone="warning">disabled</Badge>}
                {canEdit ? (
                  <Button size="sm" variant="danger" className="ml-auto" onClick={() => setDeleting(source)}>
                    Delete
                  </Button>
                ) : null}
              </div>
              <p className="t-value break-all text-body">{source.endpoint}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="t-label text-mute">Authority</dt>
                <dd className="t-value min-w-0 break-all text-body">{authorityOf(source)}</dd>
                {isMcp(source.settings) ? (
                  <>
                    <dt className="t-label text-mute">Tools</dt>
                    <dd className="t-value min-w-0 break-all text-body">
                      {source.settings.discoverTool}, {source.settings.fetchTool}
                    </dd>
                  </>
                ) : null}
                <dt className="t-label text-mute">Credential</dt>
                <dd className="t-value min-w-0 break-all text-body">
                  {source.secretName ?? <span className="font-sans text-mute">none</span>}
                </dd>
                <dt className="t-label text-mute">Last read</dt>
                <dd className="min-w-0 text-body">
                  {source.lastReadAt ? formatDate(source.lastReadAt) : <span className="text-mute">No run read it yet</span>}
                </dd>
              </dl>
            </li>
          ))}
        </ul>
      ) : null}
      <Confirm
        open={deleting !== null}
        title={`Delete the context source ${deleting?.sourceId ?? ""}?`}
        confirmLabel="Delete source"
        mutation={remove}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.sourceId)}
      >
        Runs that start after this do not read it. A run that already froze its context contract keeps its items.
        {deleting?.secretName ? ` The secret ${deleting.secretName} stays. Delete it under Secrets.` : null}
      </Confirm>
    </Section>
  );
}

function SourceForm({
  kind,
  productId,
  linearWorkspaceId,
  takenIds,
  onDone,
  onCancel,
}: {
  kind: Kind;
  productId: string;
  linearWorkspaceId: string;
  takenIds: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  const query = { linearWorkspaceId };
  const secrets = useQuery(listProductSecretsOptions({ path: { id: productId }, query }));
  const secretNames = secrets.data?.map((secret) => secret.name) ?? [];
  const secretListId = useId();

  const [sourceId, setSourceId] = useState(kind === "backstage" ? "backstage" : "");
  const [endpoint, setEndpoint] = useState("");
  const [discoverTool, setDiscoverTool] = useState("");
  const [fetchTool, setFetchTool] = useState("");
  const [authority, setAuthority] = useState<Authority>("prose_documentation");
  const [primaryComponent, setPrimaryComponent] = useState("");
  const [credential, setCredential] = useState("");
  const [secretName, setSecretName] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const name = (secretName ?? secretNameFor(sourceId)).trim();
  const storedSecret = secretNames.includes(name);

  const settings = (): Settings =>
    kind === "mcp"
      ? { kind: "mcp", discoverTool: discoverTool.trim(), fetchTool: fetchTool.trim(), authority }
      : { kind: "backstage", primaryComponent: primaryComponent.trim() || null };

  const test = useMutation({
    mutationFn: async () => {
      const body: TestContextSourceData["body"] = {
        sourceId: sourceId.trim(),
        kind,
        endpoint: endpoint.trim(),
        settings: settings(),
      };
      if (credential) body.credential = credential;
      else if (storedSecret) body.secretName = name;
      return (await testContextSource({ path: { id: productId }, query, body, throwOnError: true })).data;
    },
  });

  // Any change makes an earlier test result stale, so the result goes.
  const change =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      if (test.data || test.error) test.reset();
    };

  const save = useMutation({
    mutationFn: async () => {
      if (credential) {
        // Kind test with no injection mark: the value stays on the worker and never reaches an agent.
        await putProductSecret({
          path: { id: productId, name },
          query,
          body: { value: credential, kind: "test", injectIntoImplementer: false },
          throwOnError: true,
        });
      }
      await putContextSource({
        path: { id: productId },
        query,
        body: {
          sourceId: sourceId.trim(),
          kind,
          endpoint: endpoint.trim(),
          secretName: credential || storedSecret ? name : null,
          settings: settings(),
        },
        throwOnError: true,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: listProductSecretsQueryKey({ path: { id: productId }, query }) });
      onDone();
    },
  });
  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors : {};

  const credentialHint = credential
    ? `Factoree stores the value as the product secret ${name || "…"}${storedSecret ? " and replaces the stored value" : ""}.`
    : storedSecret
      ? `The source uses the stored secret ${name}.`
      : "Optional. Without a value and with no stored secret of this name, Factoree sends no credential.";

  const ready =
    Boolean(sourceId.trim() && endpoint.trim()) && (kind === "backstage" || Boolean(discoverTool.trim() && fetchTool.trim()));

  return (
    <form
      className="enter mb-4 flex flex-col gap-4 rounded-control border border-hairline-strong bg-raised/50 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (takenIds.includes(sourceId.trim())) {
          setLocalError(`A source named ${sourceId.trim()} exists. Choose another id, or delete that source first.`);
          return;
        }
        if (credential && !name) {
          setLocalError("Name the secret that stores the credential.");
          return;
        }
        setLocalError(null);
        save.mutate();
      }}
    >
      <p className="t-section">{kind === "mcp" ? "New MCP server" : "New Backstage catalog"}</p>
      <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
        <Field label="Source id" hint="Lower case letters, digits, dot, colon, underscore and dash." errors={fieldErrors.sourceId}>
          {(props) => (
            <Input
              {...props}
              mono
              required
              autoComplete="off"
              pattern={SOURCE_ID_PATTERN}
              placeholder={kind === "mcp" ? "docs" : "backstage"}
              value={sourceId}
              onChange={(e) => change(setSourceId)(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="URL"
          hint={kind === "mcp" ? "The MCP endpoint, for example https://mcp.example.com/mcp." : "The base URL of the Backstage backend."}
          errors={fieldErrors.endpoint}
        >
          {(props) => (
            <Input
              {...props}
              mono
              required
              type="url"
              autoComplete="off"
              placeholder="https://"
              value={endpoint}
              onChange={(e) => change(setEndpoint)(e.target.value)}
            />
          )}
        </Field>
        {kind === "mcp" ? (
          <>
            <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
              <span className="t-label">Transport</span>
              <p className="t-value text-ink">Streamable HTTP · JSON</p>
              <p className="t-hint">
                Factoree sends JSON-RPC in an HTTP POST and reads a JSON answer. It supports no other MCP transport.
              </p>
            </div>
            <Field label="Discover tool" hint="Factoree calls it with the goal, the topics and the repository.">
              {(props) => (
                <Input
                  {...props}
                  mono
                  required
                  autoComplete="off"
                  placeholder="search"
                  value={discoverTool}
                  onChange={(e) => change(setDiscoverTool)(e.target.value)}
                />
              )}
            </Field>
            <Field label="Fetch tool" hint="Factoree calls it with the ref of one item.">
              {(props) => (
                <Input
                  {...props}
                  mono
                  required
                  autoComplete="off"
                  placeholder="read"
                  value={fetchTool}
                  onChange={(e) => change(setFetchTool)(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Authority"
              hint="SDD §22. A higher class of the same domain wins a context conflict."
              className="sm:col-span-2"
            >
              {(props) => (
                <Select {...props} mono value={authority} onChange={(e) => change(setAuthority)(e.target.value as Authority)}>
                  {AUTHORITIES.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.value} · {a.domain}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        ) : (
          <Field
            label="Start entity (optional)"
            hint="Empty finds the component of the primary repository. A run reads the catalog only when the repository sets context.backstage.enabled."
            className="sm:col-span-2"
          >
            {(props) => (
              <Input
                {...props}
                mono
                autoComplete="off"
                placeholder="component:default/name"
                value={primaryComponent}
                onChange={(e) => change(setPrimaryComponent)(e.target.value)}
              />
            )}
          </Field>
        )}
        <Field label="Credential (optional)" hint={credentialHint}>
          {(props) => (
            <Input
              {...props}
              mono
              type="password"
              autoComplete="off"
              value={credential}
              onChange={(e) => change(setCredential)(e.target.value)}
            />
          )}
        </Field>
        <Field label="Secret name" hint="Factoree sends the value as a bearer token.">
          {(props) => (
            <>
              <Input
                {...props}
                mono
                autoComplete="off"
                list={secretListId}
                value={name}
                onChange={(e) => change(setSecretName)(e.target.value.toUpperCase())}
              />
              <datalist id={secretListId}>
                {secretNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </>
          )}
        </Field>
      </div>

      {test.data ? (
        <Alert tone={test.data.ok ? "success" : "danger"} title={test.data.ok ? "The source answered" : "The test failed"}>
          <p>{test.data.message}</p>
          {test.data.items.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {test.data.items.map((item) => (
                <li key={item.ref} className="flex flex-wrap gap-x-2">
                  <span className="t-value break-all text-ink">{item.ref}</span>
                  {item.title ? <span className="text-body">{item.title}</span> : null}
                </li>
              ))}
              {test.data.itemCount > test.data.items.length ? (
                <li className="t-hint">and {test.data.itemCount - test.data.items.length} more</li>
              ) : null}
            </ul>
          ) : null}
        </Alert>
      ) : null}
      <ErrorAlert error={test.error} title="The test did not run" />
      {localError ? <Alert tone="danger">{localError}</Alert> : null}
      <ErrorAlert error={save.error} />
      <div className="flex flex-wrap items-center gap-3">
        {/* Save product is the primary action of the product page. */}
        <Button type="submit" disabled={!ready} mutation={save}>
          Add source
        </Button>
        <Button disabled={!ready} mutation={test} onClick={() => test.mutate()}>
          Test
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
