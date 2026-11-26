import { createFileRoute } from "@tanstack/react-router";
import { WebResultPage } from "@/features/retro/web-result-page";
import { wsSearch } from "@/lib/search";

/** docs/specs/retro-web-research.md. One stored web result of a retro: a search hit or a page. */
export const Route = createFileRoute("/_app/retro/web-results/$resultId")({
  validateSearch: wsSearch,
  component: function WebResult() {
    const { resultId } = Route.useParams();
    const { ws } = Route.useSearch();
    return <WebResultPage resultId={resultId} ws={ws} />;
  },
});
