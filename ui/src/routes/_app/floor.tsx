import { createFileRoute } from "@tanstack/react-router";
import { FloorPage } from "@/features/floor/floor-page";
import { floorSearch } from "@/features/floor/search";

/** docs/specs/factory-floor.md. The factory floor of a workspace, live or replayed. */
export const Route = createFileRoute("/_app/floor")({
  validateSearch: floorSearch,
  component: function Floor() {
    const search = Route.useSearch();
    return <FloorPage search={search} />;
  },
});
