import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  listProductSecretsOptions,
  listSignalSourcesOptions,
  listSignalSourcesQueryKey,
} from "@/api/@tanstack/react-query.gen";
import { createSignalSource, deleteSignalSource, testSignalSource, updateSignalSource } from "@/api/sdk.gen";
import type { CreateSignalSourceData, ListSignalSourcesResponse, TestSignalSourceResponse } from "@/api/types.gen";
import { Button } from "@/components/button";
import { Confirm } from "@/components/confirm";
import { Field, Input, Select, Switch, Textarea } from "@/components/form";
import { Alert, Badge, Empty, ErrorAlert, Section, SkeletonRows } from "@/components/layout";
import { ApiError } from "@/lib/api";

type Source = ListSignalSourcesResponse["sources"][number];
type Kind = Source["kind"];
type Body = Omit<CreateSignalSourceData["body"], "linearWorkspaceId">;
type Tool = NonNullable<TestSignalSourceResponse["tools"]>[number];

/** docs/specs/retro-agent.md, the same limits as src/domain/retro/signal-source.ts. */
const MAX_QUERIES = 10;
const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_BYTES = 1024 * 1024;
const NAME_PATTERN = "[a-z0-9][a-z0-9\\-]{0,62}";
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

const KIND_LABEL: Record<Kind, string> = { errors: "errors", analytics: "analytics" };

type QueryForm = { name: string; tool: string; arguments: string; maxBytes: string };
type SourceForm = { name: string; kind: Kind; endpoint: string; secretName: string; enabled: boolean; queries: QueryForm[] };

const emptyQuery = (): QueryForm => ({ name: "", tool: "", arguments: "{}", maxBytes: String(DEFAULT_MAX_BYTES) });

const formOf = (source: Source | null): SourceForm =>
  source === null
    ? { name: "", kind: "errors", endpoint: "", secretName: "", enabled: true, queries: [emptyQuery()] }
    : {
        name: source.name,
        kind: source.kind,
        endpoint: source.endpoint,
        secretName: source.secretName ?? "",
        enabled: source.enabled,
        queries: source.queries.map((query) => ({
          name: query.name,
          tool: query.tool,
          arguments: JSON.stringify(query.arguments, null, 2),
          maxBytes: String(query.maxBytes),
        })),
      };

/** bodyOf reads the form, or names what stops a save. */
function bodyOf(form: SourceForm): { body: Body } | { problems: string[] } {
  const problems: string[] = [];
  if (!NAME.test(form.name.trim())) problems.push("The source name takes lower case letters, digits and dashes.");
  if (!/^https?:\/\/\S+$/.test(form.endpoint.trim())) problems.push("The MCP endpoint must start with http:// or https://.");
  if (form.queries.length === 0) problems.push("Add at least one query.");
  const names = new Set<string>();
  const queries = form.queries.map((query, index) => {
    const label = query.name.trim() || `${index + 1}`;
    if (!NAME.test(query.name.trim())) problems.push(`Query ${label}: the name takes lower case letters, digits and dashes.`);
    if (names.has(query.name.trim())) problems.push(`Two queries have the name ${label}.`);
    names.add(query.name.trim());
    if (!query.tool.trim()) problems.push(`Query ${label}: name the MCP tool.`);
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(query.arguments.trim() || "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      args = parsed as Record<string, unknown>;
    } catch {
      problems.push(`Query ${label}: the arguments must be a JSON object.`);
    }
    const maxBytes = Number(query.maxBytes.trim());
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES)
      problems.push(`Query ${label}: the byte cap must be a whole number from 1 to ${MAX_BYTES}.`);
    return { name: query.name.trim(), tool: query.tool.trim(), arguments: args, maxBytes };
  });
  if (problems.length > 0) return { problems };
  return {
    body: {
      name: form.name.trim(),
      kind: form.kind,
      endpoint: form.endpoint.trim(),
      secretName: form.secretName || null,
      enabled: form.enabled,
      queries,
    },
  };
}

/**
 * docs/specs/retro-agent.md. The MCP servers for production errors or product analytics that a
 * retro of this product reads. Factoree runs each query before the retro session.
 */
export function SignalSourcesSection({
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
  const sources = useQuery(listSignalSourcesOptions(options));
  // null: no form. "new": the add form. A source: its edit form.
  const [editing, setEditing] = useState<Source | "new" | null>(null);
  const [deleting, setDeleting] = useState<Source | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: listSignalSourcesQueryKey(options) });

  const remove = useMutation({
    mutationFn: async (sourceId: string) =>
      deleteSignalSource({ path: { id: productId, sourceId }, query: { linearWorkspaceId }, throwOnError: true }),
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });

  const list = sources.data?.sources ?? [];
  return (
    <Section
      title="Signal sources"
      description="MCP servers for production errors or product analytics. Before each retro, Factoree runs the queries and gives the results to the retro agent as files. The agent may also call the ticked tools live."
      actions={
        canEdit && editing === null ? (
          <Button size="sm" onClick={() => setEditing("new")}>
            Add signal source
          </Button>
        ) : null
      }
    >
      {editing !== null ? (
        <SignalSourceForm
          key={editing === "new" ? "new" : editing.id}
          source={editing === "new" ? null : editing}
          productId={productId}
          linearWorkspaceId={linearWorkspaceId}
          onDone={() => {
            setEditing(null);
            void refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {sources.isPending ? <SkeletonRows label="Loading the signal sources" /> : null}
      <ErrorAlert error={sources.error} title="The signal sources did not load" />
      <ErrorAlert error={remove.error} />
      {sources.data && list.length === 0 && editing === null ? (
        <Empty>No signal source. A retro reads the runs only, and proposes factory findings.</Empty>
      ) : null}
      {list.length > 0 ? (
        <ul className="stagger -my-2 divide-y divide-hairline">
          {list.map((source) => (
            <li key={source.id} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="t-value min-w-0 break-all text-ink">{source.name}</span>
                <Badge>{KIND_LABEL[source.kind]}</Badge>
                {source.enabled ? null : <Badge tone="warning">disabled</Badge>}
                {canEdit ? (
                  <span className="ml-auto flex gap-2">
                    <Button size="sm" disabled={editing !== null} onClick={() => setEditing(source)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setDeleting(source)}>
                      Delete
                    </Button>
                  </span>
                ) : null}
              </div>
              <p className="t-value break-all text-body">{source.endpoint}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="t-label text-mute">Credential</dt>
                <dd className="t-value min-w-0 break-all text-body">
                  {source.secretName ?? <span className="font-sans text-mute">none</span>}
                </dd>
                <dt className="t-label text-mute">Queries</dt>
                <dd className="t-value min-w-0 break-all text-body">
                  {source.queries.map((query) => `${query.name} (${query.tool})`).join(", ")}
                </dd>
                <dt className="t-label text-mute">Live tools</dt>
                <dd className="flex min-w-0 flex-wrap gap-1.5">
                  {source.tickedTools.length === 0 ? (
                    <span className="text-xs text-mute">none</span>
                  ) : (
                    source.tickedTools.map((tool) => (
                      <span key={tool} className="badge max-w-full whitespace-normal break-all">
                        {tool}
                      </span>
                    ))
                  )}
                </dd>
              </dl>
            </li>
          ))}
        </ul>
      ) : null}
      <Confirm
        open={deleting !== null}
        title={`Delete the signal source ${deleting?.name ?? ""}?`}
        confirmLabel="Delete source"
        mutation={remove}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      >
        Retros that start after this do not read it. Stored signal results stay until the retro data retention ends.
        {deleting?.secretName ? ` The secret ${deleting.secretName} stays. Delete it under Secrets.` : null}
      </Confirm>
    </Section>
  );
}

function SignalSourceForm({
  source,
  productId,
  linearWorkspaceId,
  onDone,
  onCancel,
}: {
  source: Source | null;
  productId: string;
  linearWorkspaceId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const secrets = useQuery(listProductSecretsOptions({ path: { id: productId }, query: { linearWorkspaceId } }));
  const secretNames = secrets.data?.map((secret) => secret.name) ?? [];
  const [form, setForm] = useState<SourceForm>(() => formOf(source));
  const [problems, setProblems] = useState<string[]>([]);
  // docs/specs/retro-web-research.md. The tools the agent may call live. They live outside the
  // form, so a tick does not make the test result stale.
  const savedTicks = source?.tickedTools ?? [];
  const [ticks, setTicks] = useState<string[]>(savedTicks);
  // Read-only tools are ticked by default only while the source has no saved ticks and no hand tick.
  const [handTicked, setHandTicked] = useState(savedTicks.length > 0);
  // The server's tool list from the last test. It stays while other fields change.
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);

  const test = useMutation({
    mutationFn: async (body: Body) =>
      (await testSignalSource({ path: { id: productId }, body: { ...body, linearWorkspaceId }, throwOnError: true })).data,
    onSuccess: (data) => {
      setTools(data.tools);
      setToolsError(data.toolsError);
      if (data.tools && !handTicked) setTicks(data.tools.filter((tool) => tool.readOnly).map((tool) => tool.name));
    },
  });
  const save = useMutation({
    mutationFn: async (input: Body) => {
      const body = { ...input, tickedTools: ticks };
      return source === null
        ? createSignalSource({ path: { id: productId }, body: { ...body, linearWorkspaceId }, throwOnError: true })
        : updateSignalSource({
            path: { id: productId, sourceId: source.id },
            body: { ...body, linearWorkspaceId },
            throwOnError: true,
          });
    },
    onSuccess: onDone,
  });
  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors : {};

  // Any change makes an earlier test result stale, so the result goes.
  const update = (patch: Partial<SourceForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    if (test.data || test.error) test.reset();
    // Another server or credential may list other tools.
    if (patch.endpoint !== undefined || patch.secretName !== undefined) {
      setTools(null);
      setToolsError(null);
    }
  };
  const toggleTool = (name: string, on: boolean) => {
    setHandTicked(true);
    setTicks((current) => (on ? [...current.filter((tick) => tick !== name), name] : current.filter((tick) => tick !== name)));
  };
  const updateQuery = (index: number, patch: Partial<QueryForm>) =>
    update({ queries: form.queries.map((query, i) => (i === index ? { ...query, ...patch } : query)) });

  const checked = () => {
    const result = bodyOf(form);
    if ("problems" in result) {
      setProblems(result.problems);
      return null;
    }
    setProblems([]);
    return result.body;
  };

  const storedMissing = form.secretName !== "" && secrets.data !== undefined && !secretNames.includes(form.secretName);

  return (
    <form
      className="enter mb-4 flex flex-col gap-4 rounded-control border border-hairline-strong bg-raised/50 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const body = checked();
        if (body) save.mutate(body);
      }}
    >
      <p className="t-section">{source === null ? "New signal source" : `Edit ${source.name}`}</p>
      <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
        <Field label="Name" hint="Lower case letters, digits and dashes." errors={fieldErrors.name}>
          {(props) => (
            <Input
              {...props}
              mono
              required
              autoComplete="off"
              pattern={NAME_PATTERN}
              placeholder="sentry"
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
            />
          )}
        </Field>
        <Field
          label="Kind"
          hint={
            form.kind === "errors"
              ? "Production errors. An error finding cites its results."
              : "Product analytics. An idea finding cites its results."
          }
        >
          {(props) => (
            <Select {...props} value={form.kind} onChange={(e) => update({ kind: e.target.value as Kind })}>
              <option value="errors">errors</option>
              <option value="analytics">analytics</option>
            </Select>
          )}
        </Field>
        <Field
          label="MCP endpoint"
          hint="Streamable HTTP, for example https://mcp.sentry.dev/mcp."
          errors={fieldErrors.endpoint}
          className="sm:col-span-2"
        >
          {(props) => (
            <Input
              {...props}
              mono
              required
              type="url"
              autoComplete="off"
              placeholder="https://"
              value={form.endpoint}
              onChange={(e) => update({ endpoint: e.target.value })}
            />
          )}
        </Field>
        <Field
          label="Credential"
          hint={
            storedMissing
              ? `The product holds no secret ${form.secretName}. Add it under Secrets.`
              : "A product secret. Factoree sends it as a bearer token from the worker. It never enters the sandbox."
          }
          errors={fieldErrors.secretName}
        >
          {(props) => (
            <Select {...props} mono value={form.secretName} onChange={(e) => update({ secretName: e.target.value })}>
              <option value="">No credential</option>
              {storedMissing ? <option value={form.secretName}>{form.secretName}</option> : null}
              {secretNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="flex items-end pb-2">
          <Switch checked={form.enabled} onCheckedChange={(enabled) => update({ enabled })} label="Enabled" />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <p className="t-label">Queries</p>
          <p className="t-hint mt-1">
            Factoree calls each MCP tool with its arguments before the session. The text <code className="font-mono">{"{since}"}</code>{" "}
            in an argument becomes the end time of the last successful retro, in ISO 8601. At most {MAX_QUERIES} queries.
          </p>
        </div>
        {form.queries.map((query, index) => (
          <fieldset key={index} className="flex min-w-0 flex-col gap-3 rounded-control border border-hairline p-3">
            <legend className="sr-only">Query {index + 1}</legend>
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              <Field label="Query name">
                {(props) => (
                  <Input
                    {...props}
                    mono
                    required
                    autoComplete="off"
                    pattern={NAME_PATTERN}
                    placeholder="new-issues"
                    value={query.name}
                    onChange={(e) => updateQuery(index, { name: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Tool">
                {(props) => (
                  <Input
                    {...props}
                    mono
                    required
                    autoComplete="off"
                    placeholder="search_issues"
                    value={query.tool}
                    onChange={(e) => updateQuery(index, { tool: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Arguments" hint="A JSON object." className="sm:col-span-2">
                {(props) => (
                  <Textarea
                    {...props}
                    mono
                    rows={4}
                    spellCheck={false}
                    placeholder={'{ "query": "is:unresolved firstSeen:>{since}" }'}
                    value={query.arguments}
                    onChange={(e) => updateQuery(index, { arguments: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Byte cap" hint={`Default ${DEFAULT_MAX_BYTES}, at most ${MAX_BYTES}.`}>
                {(props) => (
                  <Input
                    {...props}
                    mono
                    required
                    type="number"
                    min={1}
                    max={MAX_BYTES}
                    step={1}
                    value={query.maxBytes}
                    onChange={(e) => updateQuery(index, { maxBytes: e.target.value })}
                  />
                )}
              </Field>
              <div className="flex items-end justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove query ${query.name || index + 1}`}
                  disabled={form.queries.length === 1}
                  onClick={() => update({ queries: form.queries.filter((_, i) => i !== index) })}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  Remove
                </Button>
              </div>
            </div>
            <TestResult result={test.data?.results.find((entry) => entry.queryName === query.name.trim())} />
          </fieldset>
        ))}
        <Button
          size="sm"
          className="self-start"
          disabled={form.queries.length >= MAX_QUERIES}
          onClick={() => update({ queries: [...form.queries, emptyQuery()] })}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add query
        </Button>
      </div>

      <LiveTools tools={tools} toolsError={toolsError} ticks={ticks} onToggle={toggleTool} />

      {test.data ? (
        <Alert
          tone={test.data.results.every((result) => result.ok) ? "success" : "danger"}
          title={test.data.results.every((result) => result.ok) ? "Every query answered" : "A query failed"}
        >
          Each query shows its size and its first 500 characters, as the retro agent reads them.
        </Alert>
      ) : null}
      <ErrorAlert error={test.error} title="The test did not run" />
      {problems.length > 0 ? (
        <Alert tone="danger" title="Fix these first">
          <ul className="list-disc pl-4">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <ErrorAlert error={save.error} />
      <div className="flex flex-wrap items-center gap-3">
        {/* Save product is the primary action of the product page. */}
        <Button type="submit" mutation={save}>
          {source === null ? "Add source" : "Save source"}
        </Button>
        <Button
          mutation={test}
          onClick={() => {
            const body = checked();
            if (body) test.mutate(body);
          }}
        >
          Test
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TestResult({
  result,
}: {
  result: { ok: boolean; bytes: number | null; preview: string | null; reason: string | null } | undefined;
}) {
  if (result === undefined) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={result.ok ? "success" : "danger"}>{result.ok ? "ok" : "failed"}</Badge>
        {result.bytes !== null ? <span className="t-value text-body">{result.bytes} bytes</span> : null}
      </div>
      {result.reason ? <p className="text-xs text-danger">{result.reason}</p> : null}
      {result.preview ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-control border border-hairline bg-canvas p-2 font-mono text-xs text-body">
          {result.preview.slice(0, 500)}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * docs/specs/retro-web-research.md. The server's tools from the connection test, with a tick per
 * tool the retro agent may call live through the retro gateway. A saved tick the server no longer
 * lists stays, so it can be unticked.
 */
function LiveTools({
  tools,
  toolsError,
  ticks,
  onToggle,
}: {
  tools: Tool[] | null;
  toolsError: string | null;
  ticks: string[];
  onToggle: (name: string, on: boolean) => void;
}) {
  const listed = new Set((tools ?? []).map((tool) => tool.name));
  const rows: { name: string; description: string | null; readOnly: boolean | null }[] = [
    ...(tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, readOnly: tool.readOnly })),
    ...ticks.filter((tick) => !listed.has(tick)).map((name) => ({ name, description: null, readOnly: null })),
  ];
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="t-label">Agent may call live</p>
        <p className="t-hint mt-1">
          The retro agent may call a ticked tool during the session. The worker calls it with the credential. Test lists the
          server's tools, and ticks the read-only ones on a source with no ticks.
        </p>
      </div>
      {toolsError ? (
        <Alert tone="danger" title="The tool list did not load">
          {toolsError}
        </Alert>
      ) : null}
      {tools !== null && tools.length === 0 ? <Empty>The server lists no tool.</Empty> : null}
      {tools === null && rows.length === 0 && !toolsError ? <Empty>Test the source to list its tools.</Empty> : null}
      {rows.length > 0 ? (
        <ul className="-my-1 divide-y divide-hairline">
          {rows.map((row) => {
            const ticked = ticks.includes(row.name);
            return (
              <li key={row.name} className="flex min-w-0 items-start gap-2.5 py-2">
                <input
                  type="checkbox"
                  className="mt-0.5 shrink-0"
                  aria-label={`The agent may call ${row.name} live`}
                  checked={ticked}
                  onChange={(e) => onToggle(row.name, e.target.checked)}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="t-value min-w-0 break-all text-ink">{row.name}</span>
                    {row.readOnly === true ? <Badge>read-only</Badge> : null}
                    {ticked && row.readOnly === false ? <Badge tone="warning">may write</Badge> : null}
                    {row.readOnly === null && tools !== null ? <Badge tone="warning">not listed</Badge> : null}
                  </div>
                  {row.description ? <p className="line-clamp-2 text-xs break-words text-mute">{row.description}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
