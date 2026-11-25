import { createFileRoute } from "@tanstack/react-router";
import { SignalResultPage } from "@/features/retro/signal-result-page";
import { wsSearch } from "@/lib/search";

/** docs/specs/retro-agent.md. One stored signal result of a retro. */
export const Route = createFileRoute("/_app/retro/signal-results/$resultId")({
  validateSearch: wsSearch,
  component: function SignalResult() {
    const { resultId } = Route.useParams();
    const { ws } = Route.useSearch();
    return <SignalResultPage resultId={resultId} ws={ws} />;
  },
});
