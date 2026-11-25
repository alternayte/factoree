import { createFileRoute } from "@tanstack/react-router";
import { RetroDetailPage } from "@/features/retro/retro-detail-page";
import { wsSearch } from "@/lib/search";

/** docs/specs/retro-agent.md. One retro with its numbers, events and findings. */
export const Route = createFileRoute("/_app/retro/$retroId")({
  validateSearch: wsSearch,
  component: function Retro() {
    const { retroId } = Route.useParams();
    const { ws } = Route.useSearch();
    return <RetroDetailPage retroId={retroId} ws={ws} />;
  },
});
