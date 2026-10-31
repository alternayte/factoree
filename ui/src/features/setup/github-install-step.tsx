import { useMutation } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { bindGitHubInstallation } from "@/api/sdk.gen";
import { Button } from "@/components/button";
import { Field, Input } from "@/components/form";
import { Alert, ErrorAlert, Section } from "@/components/layout";
import { ApiError } from "@/lib/api";
import { Actions, StepFrame } from "./step-frame";
import { useSetup } from "./setup-context";

export function GitHubInstallStep() {
  const { status, setStatus, handleAuthError } = useSetup();
  const installUrl = status.githubApp.installUrl;
  const [installationId, setInstallationId] = useState("");

  const bind = useMutation({
    mutationFn: async () =>
      (await bindGitHubInstallation({ body: { installationId: installationId.trim() }, throwOnError: true })).data,
    onSuccess: (next) => {
      setStatus(next);
      setInstallationId("");
    },
    onError: handleAuthError,
  });

  const ready = status.githubApp.done && status.linearInstall.done;
  const fieldErrors = bind.error instanceof ApiError ? bind.error.fieldErrors : {};

  return (
    <StepFrame
      step="github-install"
      title="Install the GitHub App"
      done={status.githubInstall.done}
      description="Install the App on the accounts that own the repositories Factoree changes. GitHub returns here after the install."
    >
      <Section title="Install on GitHub">
        <div className="flex flex-col gap-3.5">
          {!ready ? <Alert tone="warning">Create the GitHub App and install the Linear app first.</Alert> : null}
          {status.githubInstall.accounts.length > 0 ? (
            <Alert tone="success">Installed on {status.githubInstall.accounts.join(", ")}.</Alert>
          ) : null}
          {installUrl && ready ? (
            <Actions>
              <Button asChild variant={status.githubInstall.done ? "secondary" : "primary"}>
                <a href={installUrl}>
                  {status.githubInstall.done ? "Install on another account" : "Install on GitHub"}
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              </Button>
            </Actions>
          ) : null}
        </div>
      </Section>
      <Section
        title="Bind an installation by hand"
        description={
          <>
            GitHub did not return here? Enter the installation id from the URL of the installation page
            (…/settings/installations/<span className="font-mono">id</span>).
          </>
        }
      >
        <form
          className="flex flex-col gap-3.5"
          onSubmit={(event) => {
            event.preventDefault();
            bind.mutate();
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Installation id" className="w-56" errors={fieldErrors.installationId}>
              {(props) => (
                <Input
                  {...props}
                  mono
                  required
                  inputMode="numeric"
                  pattern="\d+"
                  value={installationId}
                  disabled={!ready}
                  onChange={(e) => setInstallationId(e.target.value)}
                />
              )}
            </Field>
            <Button type="submit" disabled={!ready || !installationId.trim()} mutation={bind}>
              Bind installation
            </Button>
          </div>
          <ErrorAlert error={bind.error} />
        </form>
      </Section>
    </StepFrame>
  );
}
