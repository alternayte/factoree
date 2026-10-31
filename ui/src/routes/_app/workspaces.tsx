import { createFileRoute } from "@tanstack/react-router";
import { WorkspacesPage } from "@/features/workspaces/workspaces-page";

type Search = { linearError?: string };

export const Route = createFileRoute("/_app/workspaces")({
  validateSearch: (search: Record<string, unknown>): Search =>
    typeof search.linearError === "string" && search.linearError ? { linearError: search.linearError } : {},
  component: function Workspaces() {
    const { linearError } = Route.useSearch();
    return <WorkspacesPage linearError={linearError} />;
  },
});
