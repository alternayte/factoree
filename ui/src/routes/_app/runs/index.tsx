import { createFileRoute } from "@tanstack/react-router";
import { RunsPage, runsSearch } from "@/features/runs/runs-page";

export const Route = createFileRoute("/_app/runs/")({
  validateSearch: runsSearch,
  component: function Runs() {
    const search = Route.useSearch();
    return <RunsPage search={search} />;
  },
});
