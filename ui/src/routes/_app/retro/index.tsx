import { createFileRoute } from "@tanstack/react-router";
import { RetroPage } from "@/features/retro/retro-page";
import { wsSearch } from "@/lib/search";

/** docs/specs/retro-agent.md. The retro settings of a workspace and its retros. */
export const Route = createFileRoute("/_app/retro/")({
  validateSearch: wsSearch,
  component: function Retro() {
    const { ws } = Route.useSearch();
    return <RetroPage ws={ws} />;
  },
});
