import { createFileRoute } from "@tanstack/react-router";
import { SetupShell } from "@/features/setup/setup-shell";
import { SetupSteps } from "@/features/setup/setup-page";

type Search = { linearError?: string };

export const Route = createFileRoute("/setup/")({
  validateSearch: (search: Record<string, unknown>): Search =>
    typeof search.linearError === "string" && search.linearError ? { linearError: search.linearError } : {},
  component: SetupPage,
});

function SetupPage() {
  const { linearError } = Route.useSearch();
  return (
    <SetupShell>
      <SetupSteps linearError={linearError} />
    </SetupShell>
  );
}
