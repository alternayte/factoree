import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { getInstallSettingsOptions, getInstallSettingsQueryKey } from "@/api/@tanstack/react-query.gen";
import { testObjectStore, updateInstallSettings } from "@/api/sdk.gen";
import type { GetInstallSettingsResponse, UpdateInstallSettingsData } from "@/api/types.gen";
import { Button } from "@/components/button";
import { CopyValue } from "@/components/copy";
import { Field, FieldGrid, Input, SavedNote, Select } from "@/components/form";
import { Alert, Badge, ErrorAlert, KeyValue, PageHeader, Section, SkeletonCard, Stack } from "@/components/layout";
import { useMe } from "@/lib/session";
import { emptySandboxForm, SandboxFields, type SandboxForm } from "./sandbox-fields";
import { SandboxProvidersSection } from "./sandbox-providers-section";
import { DrainSection } from "./drain-section";

type Settings = GetInstallSettingsResponse;
type Patch = UpdateInstallSettingsData["body"];

export function InstallSettingsPage() {
  const me = useMe();
  const settings = useQuery(getInstallSettingsOptions());
  const canEdit = me.data?.operatorAdmin ?? false;

  return (
    <>
      <PageHeader
        title="Install settings"
        description="Settings for the whole install: the GitHub App, the Linear app, the sandbox image and providers, the git author, the object store, the evidence store and web search."
      />
      {!canEdit ? (
        <Alert tone="info" className="mb-4 max-w-[640px]">
          Only a Linear admin of the setup workspace changes the install settings. You see them read-only.
        </Alert>
      ) : null}
      {settings.isPending ? (
        <Stack className="lg:grid lg:grid-cols-2 lg:items-start">
          <SkeletonCard label="Loading the install settings" fields={4} />
          <SkeletonCard fields={2} />
        </Stack>
      ) : null}
      <ErrorAlert error={settings.error} title="The install settings did not load" />
      {settings.data ? (
        <Stack className="lg:grid lg:grid-cols-2 lg:items-start">
          <GitHubSection settings={settings.data} canEdit={canEdit} />
          <LinearSection settings={settings.data} canEdit={canEdit} />
          <SandboxImageSection settings={settings.data} canEdit={canEdit} />
          <GitAuthorSection settings={settings.data} canEdit={canEdit} />
          <ObjectStoreSection settings={settings.data} canEdit={canEdit} />
          <EvidenceStoreSection settings={settings.data} canEdit={canEdit} />
          <WebSearchSection settings={settings.data} canEdit={canEdit} />
          <SandboxProvidersSection
            canEdit={canEdit}
            localAllowed={settings.data.sandbox.localAllowed}
            pinnedImage={settings.data.sandbox.pinnedImage}
            defaultSize={settings.data.sandbox.defaultSize}
          />
          <DrainSection canEdit={canEdit} />
        </Stack>
      ) : null}
    </>
  );
}

function useSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Patch) => (await updateInstallSettings({ body, throwOnError: true })).data,
    onSuccess: (next) => qc.setQueryData(getInstallSettingsQueryKey(), next),
  });
}

function GitHubSection({ settings, canEdit }: { settings: Settings; canEdit: boolean }) {
  const gh = settings.github;
  const [baseUrl, setBaseUrl] = useState(gh.baseUrl);
  const [apiBaseUrl, setApiBaseUrl] = useState(gh.apiBaseUrl);
  const save = useSave();
  const changed = baseUrl.trim() !== gh.baseUrl || apiBaseUrl.trim() !== gh.apiBaseUrl;
  return (
    <Section title="GitHub App" description="Setup created the App from a manifest. Its identity is read-only.">
      <KeyValue
        items={[
          { label: "App id", value: gh.appId ?? "—" },
          { label: "App slug", value: gh.appSlug ?? "—" },
          { label: "Client id", value: gh.clientId ?? "—" },
          {
            label: "Credentials",
            prose: true,
            value: (
              <span className="flex flex-wrap gap-1.5">
                <Badge tone={gh.privateKeySet ? "success" : "warning"}>
                  private key {gh.privateKeySet ? "stored" : "missing"}
                </Badge>
                <Badge tone={gh.webhookSecretSet ? "success" : "warning"}>
                  webhook secret {gh.webhookSecretSet ? "stored" : "missing"}
                </Badge>
              </span>
            ),
          },
          { label: "Webhook URL", prose: true, value: <CopyValue value={gh.webhookUrl} label="GitHub webhook URL" /> },
          {
            label: "Install",
            prose: true,
            value: gh.installUrl ? (
              <a href={gh.installUrl} className="link inline-flex items-center gap-1">
                Install the App on an account <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            ) : (
              "—"
            ),
          },
        ]}
      />
      <form
        className="mt-4 flex flex-col gap-4 border-t border-hairline pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate({ github: { baseUrl: baseUrl.trim(), apiBaseUrl: apiBaseUrl.trim() } });
        }}
      >
        <FieldGrid>
          <Field label="GitHub URL" hint="https://github.com, or the GitHub Enterprise Server URL.">
            {(props) => (
              <Input
                {...props}
                mono
                type="url"
                required
                disabled={!canEdit}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            )}
          </Field>
          <Field label="GitHub API URL" hint="https://api.github.com, or the Enterprise …/api/v3 URL.">
            {(props) => (
              <Input
                {...props}
                mono
                type="url"
                required
                disabled={!canEdit}
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
              />
            )}
          </Field>
        </FieldGrid>
        <ErrorAlert error={save.error} />
        {canEdit ? (
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!changed} mutation={save}>
              Save GitHub URLs
            </Button>
            <SavedNote show={save.isSuccess && !changed} />
          </div>
        ) : null}
      </form>
    </Section>
  );
}

function SecretInput({
  label,
  stored,
  value,
  onChange,
  disabled,
}: {
  label: string;
  stored: boolean;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <Field
      label={label}
      trailing={<Badge tone={stored ? "success" : "warning"}>{stored ? "stored" : "not set"}</Badge>}
      hint={stored ? "Write-only. Enter a new value to replace it." : undefined}
    >
      {(props) => (
        <Input
          {...props}
          mono
          type="password"
          autoComplete="off"
          disabled={disabled}
          placeholder={stored ? "••••••••" : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

function LinearSection({ settings, canEdit }: { settings: Settings; canEdit: boolean }) {
  const linear = settings.linear;
  const [clientId, setClientId] = useState(linear.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const save = useSave();
  const patch: NonNullable<Patch["linear"]> = {
    ...(clientId.trim() && clientId.trim() !== linear.clientId ? { clientId: clientId.trim() } : {}),
    ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
    ...(webhookSecret.trim() ? { webhookSecret: webhookSecret.trim() } : {}),
  };
  const changed = Object.keys(patch).length > 0;
  return (
    <Section
      title="Linear app"
      description="The OAuth application that installs Factoree in Linear and signs people in."
    >
      <KeyValue
        items={[
          {
            label: "Install callback URL",
            prose: true,
            value: <CopyValue value={linear.installCallbackUrl} label="install callback URL" />,
          },
          {
            label: "Sign-in callback URL",
            prose: true,
            value: <CopyValue value={linear.signInCallbackUrl} label="sign-in callback URL" />,
          },
          {
            label: "Webhook URL",
            prose: true,
            value: <CopyValue value={linear.webhookUrl} label="Linear webhook URL" />,
          },
        ]}
      />
      <form
        className="mt-4 flex flex-col gap-4 border-t border-hairline pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(
            { linear: patch },
            {
              onSuccess: () => {
                setClientSecret("");
                setWebhookSecret("");
              },
            },
          );
        }}
      >
        <FieldGrid>
          <Field label="Client ID">
            {(props) => (
              <Input
                {...props}
                mono
                autoComplete="off"
                disabled={!canEdit}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            )}
          </Field>
          <SecretInput
            label="Client secret"
            stored={linear.clientSecretSet}
            value={clientSecret}
            onChange={setClientSecret}
            disabled={!canEdit}
          />
          <SecretInput
            label="Webhook signing secret"
            stored={linear.webhookSecretSet}
            value={webhookSecret}
            onChange={setWebhookSecret}
            disabled={!canEdit}
          />
        </FieldGrid>
        <ErrorAlert error={save.error} />
        {canEdit ? (
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!changed} mutation={save}>
              Save Linear app
            </Button>
            <SavedNote show={save.isSuccess && !changed} />
          </div>
        ) : null}
      </form>
    </Section>
  );
}

function sandboxFormOf(s: Settings["sandbox"]): SandboxForm {
  return {
    ...emptySandboxForm,
    image: s.image ?? "",
    registryUsername: s.registryUsername ?? "",
    registryToken: "",
  };
}

/** sandboxPatch sends only what changed. An emptied optional field becomes null, which clears it. */
function sandboxPatch(form: SandboxForm, s: Settings["sandbox"]): NonNullable<Patch["sandbox"]> {
  const patch: NonNullable<Patch["sandbox"]> = {};
  const text = (v: string) => (v.trim() ? v.trim() : null);
  if (text(form.image) !== s.image) patch.image = text(form.image);
  if (text(form.registryUsername) !== s.registryUsername) patch.registryUsername = text(form.registryUsername);
  if (form.registryToken.trim()) patch.registryToken = form.registryToken.trim();
  return patch;
}

/** docs/specs/sandbox-provider-spillover.md. One image serves every sandbox provider. */
function SandboxImageSection({ settings, canEdit }: { settings: Settings; canEdit: boolean }) {
  const s = settings.sandbox;
  const [form, setForm] = useState<SandboxForm>(() => sandboxFormOf(s));
  const save = useSave();
  // The removal is its own request, so its button shows its own state.
  const clear = useSave();
  const patch = sandboxPatch(form, s);
  const changed = Object.keys(patch).length > 0;

  return (
    <Section
      title="Sandbox image"
      description="Every sandbox provider builds its template from this image. A change builds new templates, and each repository starts cold once per provider."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate({ sandbox: patch }, { onSuccess: (next) => setForm(sandboxFormOf(next.sandbox)) });
        }}
      >
        <SandboxFields
          parts="image"
          value={form}
          onChange={setForm}
          localAllowed={s.localAllowed}
          disabled={!canEdit}
          stored={{ apiKey: false, registryToken: s.registryTokenSet }}
          pinnedImage={s.pinnedImage}
          defaultSize={s.defaultSize}
        />
        <ErrorAlert error={save.error} />
        <ErrorAlert error={clear.error} />
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!changed || clear.isPending} mutation={save}>
              Save the image
            </Button>
            {s.registryTokenSet || s.registryUsername ? (
              <Button
                variant="ghost"
                disabled={save.isPending}
                mutation={clear}
                onClick={() =>
                  clear.mutate(
                    { sandbox: { registryUsername: null, registryToken: null } },
                    { onSuccess: (next) => setForm(sandboxFormOf(next.sandbox)) },
                  )
                }
              >
                Remove the registry credentials
              </Button>
            ) : null}
            <SavedNote show={(save.isSuccess || clear.isSuccess) && !changed} />
          </div>
        ) : null}
      </form>
    </Section>
  );
}

function GitAuthorSection({ settings, canEdit }: { settings: Settings; canEdit: boolean }) {
  const author = settings.gitAuthor;
  const [name, setName] = useState(author.name);
  const [email, setEmail] = useState(author.email);
  const save = useSave();
  const changed = name.trim() !== author.name || email.trim() !== author.email;
  return (
    <Section title="Git author" description="The author of the commits Factoree publishes.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate({ gitAuthor: { name: name.trim(), email: email.trim() } });
        }}
      >
        <FieldGrid>
          <Field label="Name">
            {(props) => (
              <Input {...props} required disabled={!canEdit} value={name} onChange={(e) => setName(e.target.value)} />
            )}
          </Field>
          <Field label="Email">
            {(props) => (
              <Input
                {...props}
                type="email"
                required
                disabled={!canEdit}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </Field>
        </FieldGrid>
        <ErrorAlert error={save.error} />
        {canEdit ? (
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!changed} mutation={save}>
              Save git author
            </Button>
            <SavedNote show={save.isSuccess && !changed} />
          </div>
        ) : null}
      </form>
    </Section>
  );
}

type BucketField = Settings["objectStore"]["locked"][number];

/**
 * docs/specs/s3-object-store.md. The environment variable that sets and locks each object store field.
 * The 0.23 names FACTOREE_TRANSCRIPT_S3_* still work.
 */
const BUCKET_ENV: Record<BucketField, string> = {
  endpoint: "FACTOREE_S3_ENDPOINT",
  bucket: "FACTOREE_S3_BUCKET",
  region: "FACTOREE_S3_REGION",
  accessKey: "FACTOREE_S3_ACCESS_KEY",
  secretKey: "FACTOREE_S3_SECRET_KEY",
};

type BucketForm = Record<Exclude<BucketField, "secretKey">, string> & { secretKey: string };

const bucketFormOf = (b: Settings["objectStore"]): BucketForm => ({
  endpoint: b.endpoint ?? "",
  bucket: b.bucket ?? "",
  region: b.region ?? "",
  accessKey: b.accessKey ?? "",
  secretKey: "",
});

/** bucketPatch sends only the unlocked fields that changed. An emptied field becomes null, which clears it. */
function bucketPatch(form: BucketForm, b: Settings["objectStore"]): NonNullable<Patch["objectStore"]> {
  const patch: NonNullable<Patch["objectStore"]> = {};
  const text = (v: string) => (v.trim() ? v.trim() : null);
  for (const field of ["endpoint", "bucket", "region", "accessKey"] as const) {
    if (!b.locked.includes(field) && text(form[field]) !== b[field]) patch[field] = text(form[field]);
  }
  if (!b.locked.includes("secretKey") && form.secretKey.trim()) patch.secretKey = form.secretKey.trim();
  return patch;
}

/**
 * docs/specs/s3-object-store.md. The install's one S3-compatible object store. It holds kept
 * transcripts and, when it is the evidence store, evidence. A FACTOREE_S3_* environment variable
 * wins and locks its field. The test proves the saved store, so a change needs a new test.
 */
function ObjectStoreSection({ settings, canEdit }: { settings: Settings; canEdit: boolean }) {
  const b = settings.objectStore;
  const qc = useQueryClient();
  const [form, setForm] = useState<BucketForm>(() => bucketFormOf(b));
  const save = useSave();
  const clear = useSave();
  const test = useMutation({
    mutationFn: async () => (await testObjectStore({ throwOnError: true })).data,
    onSettled: () => qc.invalidateQueries({ queryKey: getInstallSettingsQueryKey() }),
  });
  const patch = bucketPatch(form, b);
  const changed = Object.keys(patch).length > 0;
  const locked = (field: BucketField) => b.locked.includes(field);
  const lockHint = (field: BucketField) => `Locked. The environment variable ${BUCKET_ENV[field]} sets it.`;
  const set = (field: keyof BucketForm) => (value: string) => setForm((f) => ({ ...f, [field]: value }));
  const unlockedStored =
    (["endpoint", "bucket", "region", "accessKey"] as const).some((field) => !locked(field) && b[field] !== null) ||
    (!locked("secretKey") && b.secretKeySet);
  const afterSave = (next: Settings) => {
    setForm(bucketFormOf(next.objectStore));
    test.reset();
  };

  const text = (field: Exclude<BucketField, "secretKey">, label: string, hint: string, placeholder: string, type = "text") => (
    <Field
      label={label}
      hint={locked(field) ? lockHint(field) : hint}
      trailing={locked(field) ? <Badge>locked</Badge> : undefined}
    >
      {(props) => (
        <Input
          {...props}
          mono
          type={type}
          autoComplete="off"
          disabled={!canEdit || locked(field)}
          placeholder={placeholder}
          value={form[field]}
          onChange={(e) => set(field)(e.target.value)}
        />
      )}
    </Field>
  );

  return (
    <Section
      title="Object store"
      description="An S3-compatible bucket. It holds kept transcripts and, when it is the evidence store, evidence. Without a complete bucket, transcripts go to Postgres."
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="t-label text-mute">Transcripts go to</span>
        {b.active ? <Badge tone="success">the bucket</Badge> : <Badge>Postgres</Badge>}
        {b.active ? (
          b.tested ? (
            <Badge tone="success">Tested</Badge>
          ) : (
            <Badge tone="warning">Not tested since the last change</Badge>
          )
        ) : null}
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate({ objectStore: patch }, { onSuccess: afterSave });
        }}
      >
        <FieldGrid>
          {text("endpoint", "Endpoint", "The S3 API URL, for example https://s3.eu-west-2.amazonaws.com.", "https://", "url")}
          {text("bucket", "Bucket", "The bucket name.", "factoree")}
          {text("region", "Region", "The bucket region.", "eu-west-2")}
          {text("accessKey", "Access key", "The access key id.", "")}
          {locked("secretKey") ? (
            <Field label="Secret key" hint={lockHint("secretKey")} trailing={<Badge>locked</Badge>}>
              {(props) => <Input {...props} mono type="password" disabled placeholder="••••••••" value="" readOnly />}
            </Field>
          ) : (
            <SecretInput
              label="Secret key"
              stored={b.secretKeySet}
              value={form.secretKey}
              onChange={set("secretKey")}
              disabled={!canEdit}
            />
          )}
        </FieldGrid>
        <ErrorAlert error={save.error} />
        <ErrorAlert error={clear.error} />
        <ErrorAlert error={test.error} title="The test did not run" />
        {test.data?.ok ? (
          <Alert tone="success" title="The object store works">
            Factoree wrote, read and deleted a test object.
          </Alert>
        ) : null}
        {test.data && !test.data.ok ? (
          <Alert tone="danger" title="The object store test failed">
            {test.data.error ?? "The store gave no reason."}
          </Alert>
        ) : null}
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!changed || clear.isPending || test.isPending} mutation={save}>
              Save the bucket
            </Button>
            {b.active ? (
              <Button
                variant="ghost"
                disabled={changed || save.isPending || clear.isPending}
                mutation={test}
                onClick={() => test.mutate()}
              >
                Test object store
              </Button>
            ) : null}
            {unlockedStored ? (
              <Button
                variant="ghost"
                disabled={save.isPending || test.isPending}
                mutation={clear}
                onClick={() => {
                  const cleared: NonNullable<Patch["objectStore"]> = {};
                  for (const field of ["endpoint", "bucket", "region", "accessKey", "secretKey"] as const) {
                    if (!locked(field)) cleared[field] = null;
                  }
                  clear.mutate({ objectStore: cleared }, { onSuccess: afterSave });
                }}
              >
                Remove the bucket
              </Button>
            ) : null}
            <SavedNote show={(save.isSuccess || clear.isSuccess) && !changed} />
            {changed && b.active ? <span className="t-hint">Save before you test.</span> : null}
          </div>
        ) : null}
      </form>
    </Section>
  );
}

type EvidenceStore = Settings["evidenceStorage"]["value"];

const EVIDENCE_STORES: { value: EvidenceStore; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "s3", label: "Object store (S3)" },
  { value: "filesystem", label: "Filesystem" },
];

/**
 * docs/specs/s3-object-store.md. Where a new artifact goes. FACTOREE_EVIDENCE_STORAGE wins and locks
 * the choice. S3 needs a passing object store test, and the API answers 422 without one.
 */
function EvidenceStoreSection({ settings, canEdit }: { settings: Settings; canEdit: boolean }) {
  const e = settings.evidenceStorage;
  const [value, setValue] = useState<EvidenceStore>(e.value);
  const save = useSave();
  const changed = !e.locked && value !== e.value;
  const hint = e.locked
    ? "Set by FACTOREE_EVIDENCE_STORAGE."
    : !e.s3Allowed
      ? "Test the object store first."
      : undefined;
  return (
    <Section
      title="Evidence store"
      description="A new artifact goes to the chosen store. Old artifacts stay where they are. With the object store, screenshots and videos open through open links that need no sign-in. Logs, traces and documents need a Factoree sign-in."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate({ evidenceStorage: value }, { onSuccess: (next) => setValue(next.evidenceStorage.value) });
        }}
      >
        <Field
          label="Evidence store"
          hint={hint}
          trailing={e.locked ? <Badge>locked</Badge> : undefined}
          className="max-w-80"
        >
          {(props) => (
            <Select
              {...props}
              disabled={!canEdit || e.locked}
              value={e.locked ? e.value : value}
              onChange={(event) => setValue(event.target.value as EvidenceStore)}
            >
              {EVIDENCE_STORES.map((store) => (
                <option
                  key={store.value}
                  value={store.value}
                  disabled={store.value === "s3" && !e.s3Allowed && e.value !== "s3"}
                >
                  {store.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <p className="t-hint">A change of the master key breaks every open link.</p>
        <ErrorAlert error={save.error} />
        {canEdit && !e.locked ? (
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!changed} mutation={save}>
              Save the evidence store
            </Button>
            <SavedNote show={save.isSuccess && !changed} />
          </div>
        ) : null}
      </form>
    </Section>
  );
}

/**
 * docs/specs/retro-web-research.md. The Exa key for the retro gateway's web_search and fetch_page.
 * FACTOREE_WEB_SEARCH_EXA_API_KEY wins and locks the field.
 */
function WebSearchSection({ settings, canEdit }: { settings: Settings; canEdit: boolean }) {
  const w = settings.webSearch;
  const [key, setKey] = useState("");
  const save = useSave();
  const clear = useSave();
  const changed = key.trim() !== "";
  return (
    <Section
      title="Web search"
      description="The Exa API key. With it, a product that turns on Web research lets the retro agent search the web and read the pages it found. The query text goes to Exa."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate({ webSearch: { exaApiKey: key.trim() } }, { onSuccess: () => setKey("") });
        }}
      >
        {w.locked ? (
          <Field
            label="Exa API key"
            hint="Locked. The environment variable FACTOREE_WEB_SEARCH_EXA_API_KEY sets it."
            trailing={<Badge>locked</Badge>}
          >
            {(props) => <Input {...props} mono type="password" disabled placeholder="••••••••" value="" readOnly />}
          </Field>
        ) : (
          <SecretInput label="Exa API key" stored={w.exaKeySet} value={key} onChange={setKey} disabled={!canEdit} />
        )}
        <ErrorAlert error={save.error} />
        <ErrorAlert error={clear.error} />
        {canEdit && !w.locked ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!changed || clear.isPending} mutation={save}>
              Save the key
            </Button>
            {w.exaKeySet ? (
              <Button
                variant="ghost"
                disabled={save.isPending}
                mutation={clear}
                onClick={() => clear.mutate({ webSearch: { exaApiKey: null } }, { onSuccess: () => setKey("") })}
              >
                Remove the key
              </Button>
            ) : null}
            <SavedNote show={(save.isSuccess || clear.isSuccess) && !changed} />
          </div>
        ) : null}
      </form>
    </Section>
  );
}
