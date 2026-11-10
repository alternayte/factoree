import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { getInstallSettingsOptions, getInstallSettingsQueryKey } from "@/api/@tanstack/react-query.gen";
import { updateInstallSettings } from "@/api/sdk.gen";
import type { GetInstallSettingsResponse, UpdateInstallSettingsData } from "@/api/types.gen";
import { Button } from "@/components/button";
import { CopyValue } from "@/components/copy";
import { Field, FieldGrid, Input, SavedNote } from "@/components/form";
import { Alert, Badge, ErrorAlert, KeyValue, PageHeader, Section, SkeletonCard, Stack } from "@/components/layout";
import { useMe } from "@/lib/session";
import { emptySandboxForm, SandboxFields, type SandboxForm } from "./sandbox-fields";
import { SandboxProvidersSection } from "./sandbox-providers-section";

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
        description="Settings for the whole install: the GitHub App, the Linear app, the sandbox image and providers, and the git author."
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
          <SandboxProvidersSection
            canEdit={canEdit}
            localAllowed={settings.data.sandbox.localAllowed}
            pinnedImage={settings.data.sandbox.pinnedImage}
            defaultSize={settings.data.sandbox.defaultSize}
          />
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
