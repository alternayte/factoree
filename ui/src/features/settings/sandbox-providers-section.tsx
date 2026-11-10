import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listSandboxProvidersOptions, listSandboxProvidersQueryKey } from "@/api/@tanstack/react-query.gen";
import { createSandboxProvider, deleteSandboxProvider, updateSandboxProvider } from "@/api/sdk.gen";
import type {
  CreateSandboxProviderData,
  ListSandboxProvidersResponse,
  UpdateSandboxProviderData,
} from "@/api/types.gen";
import { Button } from "@/components/button";
import { Field, Input, SavedNote, Switch } from "@/components/form";
import { Alert, Badge, Empty, ErrorAlert, Section, SkeletonRows } from "@/components/layout";
import { ApiError } from "@/lib/api";
import {
  emptySandboxForm,
  parseMaxLive,
  parseSize,
  PROVIDER_LABELS,
  SandboxFields,
  type SandboxForm,
  type SandboxProvider,
  type SandboxSize,
} from "./sandbox-fields";

type Provider = ListSandboxProvidersResponse[number];

type ProviderForm = SandboxForm & { name: string; priority: string; enabled: boolean };

const emptyProviderForm: ProviderForm = { ...emptySandboxForm, name: "", priority: "1", enabled: true };

function formOf(provider: Provider): ProviderForm {
  return {
    ...emptySandboxForm,
    provider: provider.type as SandboxProvider,
    url: provider.url ?? "",
    maxLive: provider.maxLive === null ? "" : String(provider.maxLive),
    vcpus: provider.vcpus === null ? "" : String(provider.vcpus),
    memoryMb: provider.memoryMb === null ? "" : String(provider.memoryMb),
    name: provider.name,
    priority: String(provider.priority),
    enabled: provider.enabled,
  };
}

type Body = NonNullable<UpdateSandboxProviderData["body"]>;

/** bodyOf reads the form. With `current` it sends only what changed; an emptied field becomes null. */
function bodyOf(form: ProviderForm, current?: Provider): Body | string {
  if (!form.name.trim()) return "The provider needs a name.";
  const priority = Number(form.priority.trim());
  if (!Number.isInteger(priority) || priority < 1 || priority > 100)
    return "The priority must be a whole number from 1 to 100.";
  const maxLive = parseMaxLive(form.maxLive);
  if (maxLive === undefined) return "The live sandbox limit must be a whole number above 0.";
  const size = parseSize(form);
  if (typeof size === "string") return size;
  const local = form.provider === "local";
  const sized = form.provider === "kiln" || form.provider === "e2b";
  const url = local || !form.url.trim() ? null : form.url.trim();
  const next: Body = {
    name: form.name.trim(),
    type: form.provider,
    url,
    maxLive,
    vcpus: sized ? size.vcpus : null,
    memoryMb: sized ? size.memoryMb : null,
    priority,
    enabled: form.enabled,
  };
  if (form.apiKey.trim() && !local) next.apiKey = form.apiKey.trim();
  if (current === undefined) return next;
  const patch: Body = {};
  if (next.name !== current.name) patch.name = next.name;
  if (next.type !== current.type) patch.type = next.type;
  if (next.url !== current.url) patch.url = next.url;
  if (next.maxLive !== current.maxLive) patch.maxLive = next.maxLive;
  if (next.vcpus !== current.vcpus) patch.vcpus = next.vcpus;
  if (next.memoryMb !== current.memoryMb) patch.memoryMb = next.memoryMb;
  if (next.priority !== current.priority) patch.priority = next.priority;
  if (next.enabled !== current.enabled) patch.enabled = next.enabled;
  if (next.apiKey !== undefined) patch.apiKey = next.apiKey;
  return patch;
}

function sizeOf(provider: Provider, defaults: SandboxSize): string | null {
  if (provider.type !== "kiln" && provider.type !== "e2b") return null;
  return `${provider.vcpus ?? defaults.vcpus} vCPU · ${provider.memoryMb ?? defaults.memoryMb} MB`;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * docs/specs/sandbox-provider-spillover.md. The sandbox providers of the install. A run takes the
 * enabled provider with the best priority that has room for its 3 sandboxes. Providers of one
 * priority share the runs. A worse priority takes only the spillover.
 */
export function SandboxProvidersSection({
  canEdit,
  localAllowed,
  pinnedImage,
  defaultSize,
}: {
  canEdit: boolean;
  localAllowed: boolean;
  pinnedImage: string | null;
  defaultSize: SandboxSize;
}) {
  const providers = useQuery(listSandboxProvidersOptions());
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const list = providers.data ?? [];

  return (
    <Section
      title="Sandbox providers"
      description="A run takes the enabled provider with the best priority (lowest number) that has room for its 3 sandboxes. Providers with the same priority share the runs. A worse priority takes only the runs the better ones have no room for."
      actions={
        canEdit && !adding ? (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add a provider
          </Button>
        ) : null
      }
      className="lg:col-span-2"
    >
      <div className="flex flex-col gap-3">
        {providers.isPending ? <SkeletonRows label="Loading the sandbox providers" /> : null}
        <ErrorAlert error={providers.error} title="The sandbox providers did not load" />
        {providers.data && list.length === 0 && !adding ? <Empty>No sandbox provider. Runs cannot start.</Empty> : null}
        {list.map((provider) =>
          editing === provider.id ? (
            <ProviderEditor
              key={provider.id}
              current={provider}
              localAllowed={localAllowed}
              pinnedImage={pinnedImage}
              defaultSize={defaultSize}
              onDone={() => setEditing(null)}
            />
          ) : (
            <ProviderRow
              key={provider.id}
              provider={provider}
              defaultSize={defaultSize}
              canEdit={canEdit}
              onEdit={() => setEditing(provider.id)}
            />
          ),
        )}
        {adding ? (
          <ProviderEditor
            localAllowed={localAllowed}
            pinnedImage={pinnedImage}
            defaultSize={defaultSize}
            onDone={() => setAdding(false)}
          />
        ) : null}
      </div>
    </Section>
  );
}

function ProviderRow({
  provider,
  defaultSize,
  canEdit,
  onEdit,
}: {
  provider: Provider;
  defaultSize: SandboxSize;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: async () => {
      await deleteSandboxProvider({ path: { id: provider.id }, throwOnError: true });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: listSandboxProvidersQueryKey() }),
  });
  const toggle = useMutation({
    mutationFn: async () =>
      (
        await updateSandboxProvider({
          path: { id: provider.id },
          body: { enabled: !provider.enabled },
          throwOnError: true,
        })
      ).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: listSandboxProvidersQueryKey() }),
  });
  const size = sizeOf(provider, defaultSize);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">{provider.name}</span>
        <Badge>{PROVIDER_LABELS[provider.type as SandboxProvider] ?? provider.type}</Badge>
        <Badge>priority {provider.priority}</Badge>
        {!provider.enabled ? <Badge tone="warning">disabled</Badge> : null}
        {provider.downUntil ? <Badge tone="danger">down until {time(provider.downUntil)}</Badge> : null}
        {provider.enabled && !provider.downUntil && !provider.problem ? <Badge tone="success">in use</Badge> : null}
      </div>
      <p className="t-hint">
        <span className="font-mono">{provider.id}</span>
        {" · "}
        {provider.live} live{provider.maxLive === null ? ", no limit" : ` of ${provider.maxLive}`}
        {size ? ` · ${size}` : null}
        {provider.url ? (
          <>
            {" · "}
            <span className="font-mono break-all">{provider.url}</span>
          </>
        ) : null}
      </p>
      {provider.problem ? <Alert tone="danger">{provider.problem}</Alert> : null}
      {provider.downUntil && provider.downReason ? (
        <Alert tone="warning">The last work sprite create failed: {provider.downReason}</Alert>
      ) : null}
      <ErrorAlert error={remove.error} />
      <ErrorAlert error={toggle.error} />
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={onEdit}>
            Edit
          </Button>
          <Button variant="ghost" mutation={toggle} onClick={() => toggle.mutate()}>
            {provider.enabled ? "Disable" : "Enable"}
          </Button>
          <Button
            variant="ghost"
            mutation={remove}
            disabled={provider.live > 0}
            onClick={() => {
              if (window.confirm(`Delete the sandbox provider ${provider.name}?`)) remove.mutate();
            }}
          >
            Delete
          </Button>
          {provider.live > 0 ? (
            <span className="t-hint">Disable it and wait until its sandboxes end to delete it.</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ProviderEditor({
  current,
  localAllowed,
  pinnedImage,
  defaultSize,
  onDone,
}: {
  current?: Provider;
  localAllowed: boolean;
  pinnedImage: string | null;
  defaultSize: SandboxSize;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<ProviderForm>(() => (current ? formOf(current) : emptyProviderForm));
  const body = bodyOf(form, current);
  const changed = typeof body === "string" || Object.keys(body).length > 0;
  const save = useMutation({
    mutationFn: async (next: Body) =>
      current
        ? (await updateSandboxProvider({ path: { id: current.id }, body: next, throwOnError: true })).data
        : (await createSandboxProvider({ body: next as CreateSandboxProviderData["body"], throwOnError: true })).data,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: listSandboxProvidersQueryKey() });
      onDone();
    },
  });
  const set = <K extends keyof ProviderForm>(key: K, value: ProviderForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <form
      className="flex flex-col gap-4 rounded-md border border-line p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (typeof body !== "string") save.mutate(body);
      }}
    >
      <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
        <Field label="Name">
          {(props) => (
            <Input
              {...props}
              required
              placeholder="Kiln box 1"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
            />
          )}
        </Field>
        <Field label="Priority" hint="1 is the best. Equal priorities share the runs.">
          {(props) => (
            <Input
              {...props}
              type="number"
              min={1}
              max={100}
              step={1}
              required
              value={form.priority}
              onChange={(e) => set("priority", e.target.value)}
            />
          )}
        </Field>
      </div>
      <SandboxFields
        parts="provider"
        value={form}
        onChange={(next) => setForm((f) => ({ ...f, ...next }))}
        localAllowed={localAllowed}
        stored={current ? { apiKey: current.apiKeySet, registryToken: false } : undefined}
        pinnedImage={pinnedImage}
        defaultSize={defaultSize}
        fieldErrors={save.error instanceof ApiError ? save.error.fieldErrors : {}}
      />
      <Switch
        checked={form.enabled}
        onCheckedChange={(value) => set("enabled", value)}
        label="Runs can use this provider"
      />
      {typeof body === "string" ? <Alert tone="danger">{body}</Alert> : null}
      <ErrorAlert error={save.error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!changed || typeof body === "string"} mutation={save}>
          {current ? "Save the provider" : "Add the provider"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <SavedNote show={save.isSuccess} />
      </div>
    </form>
  );
}
