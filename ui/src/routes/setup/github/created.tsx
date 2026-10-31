import { createFileRoute } from "@tanstack/react-router";
import { convertGitHubAppManifest } from "@/api/sdk.gen";
import { GitHubReturn } from "@/features/setup/github-return";
import { SetupShell } from "@/features/setup/setup-shell";

type Search = { code?: string; state?: string };

// GitHub returns here after the App is created from the manifest (redirect_url of the manifest).
export const Route = createFileRoute("/setup/github/created")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    ...(typeof search.code === "string" ? { code: search.code } : {}),
    ...(typeof search.state === "string" ? { state: search.state } : {}),
  }),
  component: CreatedPage,
});

function CreatedPage() {
  const { code, state } = Route.useSearch();
  return (
    <SetupShell centered>
      <GitHubReturn
        label="Creating the GitHub App"
        missing={code && state ? null : "GitHub returned no code. Start the GitHub App step again."}
        run={async () =>
          (await convertGitHubAppManifest({ body: { code: code ?? "", state: state ?? "" }, throwOnError: true })).data
        }
      />
    </SetupShell>
  );
}
