import { createFileRoute } from "@tanstack/react-router";
import { bindGitHubInstallation } from "@/api/sdk.gen";
import { GitHubReturn } from "@/features/setup/github-return";
import { SetupShell } from "@/features/setup/setup-shell";

type Search = { installation_id?: string; setup_action?: string };

// GitHub returns here after an install of the App (setup_url of the manifest).
export const Route = createFileRoute("/setup/github/installed")({
  validateSearch: (search: Record<string, unknown>): Search => {
    const id = search.installation_id;
    return {
      ...(typeof id === "string" || typeof id === "number" ? { installation_id: String(id) } : {}),
      ...(typeof search.setup_action === "string" ? { setup_action: search.setup_action } : {}),
    };
  },
  component: InstalledPage,
});

function InstalledPage() {
  const { installation_id: installationId, setup_action: action } = Route.useSearch();
  const missing =
    action === "request"
      ? "GitHub sent an install request to an organization owner. Bind the installation after the owner approves it."
      : installationId
        ? null
        : "GitHub returned no installation id. Enter it by hand in the install step.";
  return (
    <SetupShell centered>
      <GitHubReturn
        label="Binding the GitHub App installation"
        missing={missing}
        run={async () =>
          (await bindGitHubInstallation({ body: { installationId: installationId ?? "" }, throwOnError: true })).data
        }
      />
    </SetupShell>
  );
}
