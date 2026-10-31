import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createGitHubAppManifest } from "@/api/sdk.gen";
import { Button } from "@/components/button";
import { Field, Input } from "@/components/form";
import { ErrorAlert, KeyValue, Section } from "@/components/layout";
import { ApiError } from "@/lib/api";
import { Actions, FieldGrid, StepFrame } from "./step-frame";
import { useSetup } from "./setup-context";

/**
 * The GitHub App manifest flow: the API signs a manifest, the browser posts it to GitHub in a
 * real form, and GitHub returns to /setup/github/created with a code.
 */
export function GitHubAppStep() {
  const { status, handleAuthError } = useSetup();
  const app = status.githubApp;
  const [name, setName] = useState("Factoree");
  const [organization, setOrganization] = useState("");
  const [baseUrl, setBaseUrl] = useState(app.baseUrl);
  const [apiBaseUrl, setApiBaseUrl] = useState(app.apiBaseUrl);
  const [post, setPost] = useState<{ postUrl: string; manifest: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const manifest = useMutation({
    mutationFn: async () =>
      (
        await createGitHubAppManifest({
          body: {
            name: name.trim(),
            organization: organization.trim() || null,
            ...(baseUrl.trim() ? { githubBaseUrl: baseUrl.trim() } : {}),
            ...(apiBaseUrl.trim() ? { githubApiBaseUrl: apiBaseUrl.trim() } : {}),
          },
          throwOnError: true,
        })
      ).data,
    onSuccess: setPost,
    onError: handleAuthError,
  });

  useEffect(() => {
    if (post) formRef.current?.submit();
  }, [post]);

  const fieldErrors = manifest.error instanceof ApiError ? manifest.error.fieldErrors : {};

  return (
    <StepFrame
      step="github-app"
      title="GitHub App"
      done={app.done}
      description="Factoree creates its GitHub App from a manifest. GitHub asks you to confirm, then returns here."
    >
      {app.done ? (
        <Section title="Current App">
          <KeyValue
            items={[
              { label: "App", value: app.appSlug ?? "—" },
              { label: "GitHub URL", value: app.baseUrl },
              { label: "GitHub API URL", value: app.apiBaseUrl },
            ]}
          />
        </Section>
      ) : null}
      <Section
        title={app.done ? "Replace the App" : "Create the App"}
        description={app.done ? "Create the App again only to replace it." : undefined}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            manifest.mutate();
          }}
        >
          <FieldGrid>
            <Field
              label="App name"
              hint="At most 34 characters. GitHub names must be unique."
              errors={fieldErrors.name}
            >
              {(props) => (
                <Input {...props} required maxLength={34} value={name} onChange={(e) => setName(e.target.value)} />
              )}
            </Field>
            <Field
              label="Organization (optional)"
              hint="Empty creates the App on your personal account."
              errors={fieldErrors.organization}
            >
              {(props) => (
                <Input
                  {...props}
                  mono
                  value={organization}
                  placeholder="acme"
                  onChange={(e) => setOrganization(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="GitHub URL"
              hint="Change only for GitHub Enterprise Server."
              errors={fieldErrors.githubBaseUrl}
            >
              {(props) => (
                <Input {...props} mono type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              )}
            </Field>
            <Field
              label="GitHub API URL"
              hint="Change only for GitHub Enterprise Server."
              errors={fieldErrors.githubApiBaseUrl}
            >
              {(props) => (
                <Input {...props} mono type="url" value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} />
              )}
            </Field>
          </FieldGrid>
          <ErrorAlert error={manifest.error} />
          <Actions>
            <Button
              type="submit"
              variant={app.done ? "secondary" : "primary"}
              mutation={manifest}
              pending={post !== null}
            >
              {app.done ? "Create the App again on GitHub" : "Create the App on GitHub"}
            </Button>
          </Actions>
        </form>
      </Section>
      {post ? (
        <form ref={formRef} method="post" action={post.postUrl} className="hidden" aria-hidden>
          <input type="hidden" name="manifest" value={post.manifest} />
        </form>
      ) : null}
    </StepFrame>
  );
}
