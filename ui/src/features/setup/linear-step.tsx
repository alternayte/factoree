import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { adoptSetupLinearInstall, putLinearApp, startSetupLinearInstall } from "@/api/sdk.gen";
import { Button } from "@/components/button";
import { CopyValue } from "@/components/copy";
import { Field, Input } from "@/components/form";
import { Alert, ErrorAlert, Section } from "@/components/layout";
import { ApiError } from "@/lib/api";
import { Actions, FieldGrid, StepFrame } from "./step-frame";
import { useSetup } from "./setup-context";

export function LinearStep({ linearError }: { linearError?: string }) {
  const { status, setStatus, handleAuthError } = useSetup();
  const app = status.linearApp;
  const install = status.linearInstall;
  const [clientId, setClientId] = useState(app.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  const save = useMutation({
    mutationFn: async () =>
      (
        await putLinearApp({
          body: { clientId: clientId.trim(), clientSecret: clientSecret.trim(), webhookSecret: webhookSecret.trim() },
          throwOnError: true,
        })
      ).data,
    onSuccess: (next) => {
      setStatus(next);
      setClientSecret("");
      setWebhookSecret("");
    },
    onError: handleAuthError,
  });

  const startInstall = useMutation({
    mutationFn: async () => (await startSetupLinearInstall({ throwOnError: true })).data,
    onSuccess: ({ url }) => window.location.assign(url),
    onError: handleAuthError,
  });

  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors : {};

  const adopt = useMutation({
    mutationFn: async (tenantId: string) =>
      (await adoptSetupLinearInstall({ body: { tenantId }, throwOnError: true })).data,
    onSuccess: (next) => setStatus(next),
    onError: handleAuthError,
  });

  return (
    <StepFrame
      step="linear"
      title="Linear app"
      done={app.done && install.done}
      description="Create an OAuth application in Linear (Settings → API → OAuth applications), then store its credentials here and install it."
    >
      <Section
        title="1. Register these URLs in the Linear app"
        description="Add both callback URLs to the app. Turn on webhooks with the webhook URL, and keep the webhook signing secret for the next step."
      >
        <div className="flex flex-col gap-3">
          <UrlRow label="Callback URL for the install" value={app.installCallbackUrl} />
          <UrlRow label="Callback URL for sign-in" value={app.signInCallbackUrl} />
          <UrlRow label="Webhook URL" value={app.webhookUrl} />
        </div>
      </Section>

      <Section
        title="2. Store the credentials"
        description={
          app.done
            ? `Factoree holds credentials for client ${app.clientId}. Enter all three values again to replace them.`
            : undefined
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <FieldGrid>
            <Field label="Client ID" errors={fieldErrors.clientId}>
              {(props) => (
                <Input
                  {...props}
                  mono
                  required
                  autoComplete="off"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
              )}
            </Field>
            <Field label="Client secret" errors={fieldErrors.clientSecret}>
              {(props) => (
                <Input
                  {...props}
                  mono
                  required
                  type="password"
                  autoComplete="off"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
              )}
            </Field>
            <Field label="Webhook signing secret" errors={fieldErrors.webhookSecret}>
              {(props) => (
                <Input
                  {...props}
                  mono
                  required
                  type="password"
                  autoComplete="off"
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                />
              )}
            </Field>
          </FieldGrid>
          <ErrorAlert error={save.error} />
          <Actions>
            <Button type="submit" variant={app.done ? "secondary" : "primary"} mutation={save}>
              {app.done ? "Replace the credentials" : "Store the credentials"}
            </Button>
          </Actions>
        </form>
      </Section>

      <Section
        title="3. Install in Linear"
        description={
          install.done
            ? undefined
            : "Linear asks a workspace admin to approve the app, then returns here. This workspace becomes the setup workspace, and its admins administer Factoree."
        }
      >
        <div className="flex flex-col gap-3.5">
          {linearError ? (
            <Alert tone="danger" title="The Linear install did not finish">
              Linear returned: {linearError.replaceAll("_", " ")}
            </Alert>
          ) : null}
          {install.done ? (
            <Alert tone="success">
              Installed in the Linear workspace {install.workspaceName ?? install.linearWorkspaceId}.
            </Alert>
          ) : null}
          {!install.done && install.existing.length > 0 ? (
            <Alert tone="info" title="The app is already installed">
              Linear stops at "already installed" for a workspace that has the app. Use the stored installation instead.
            </Alert>
          ) : null}
          <ErrorAlert error={adopt.error} />
          <ErrorAlert error={startInstall.error} />
          <Actions>
            {/* One primary action per view: the install is primary once the credentials are stored. */}
            <Button
              variant={app.done && !install.done ? "primary" : "secondary"}
              disabled={!app.done}
              mutation={startInstall}
              onClick={() => startInstall.mutate()}
            >
              {install.done ? "Install again in Linear" : "Install in Linear"}
            </Button>
            {!install.done
              ? install.existing.map((existing) => (
                  <Button
                    key={existing.tenantId}
                    variant="secondary"
                    mutation={adopt}
                    onClick={() => adopt.mutate(existing.tenantId)}
                  >
                    Use the installation in {existing.workspaceName}
                  </Button>
                ))
              : null}
          </Actions>
        </div>
      </Section>
    </StepFrame>
  );
}

function UrlRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="t-label">{label}</span>
      <CopyValue value={value} label={label} />
    </div>
  );
}
