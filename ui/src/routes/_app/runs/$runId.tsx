import { createFileRoute } from "@tanstack/react-router";
import { RunPage } from "@/features/runs/run-page";
import { wsSearch } from "@/lib/search";

export const Route = createFileRoute("/_app/runs/$runId")({
  validateSearch: wsSearch,
  component: function Run() {
    const { runId } = Route.useParams();
    const { ws } = Route.useSearch();
    return <RunPage runId={runId} ws={ws} />;
  },
});
