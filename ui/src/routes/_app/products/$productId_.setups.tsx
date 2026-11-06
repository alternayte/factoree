import { createFileRoute } from "@tanstack/react-router";
import { SetupHistoryPage } from "@/features/products/setup-history-page";

/** docs/specs/setup-speed-and-history.md. The setup history of one repository of a product. */
export type SetupHistorySearch = { ws?: string; repository: string };

export const Route = createFileRoute("/_app/products/$productId_/setups")({
  validateSearch: (search: Record<string, unknown>): SetupHistorySearch => ({
    ...(typeof search.ws === "string" && search.ws ? { ws: search.ws } : {}),
    repository: typeof search.repository === "string" ? search.repository : "",
  }),
  component: function SetupHistory() {
    const { productId } = Route.useParams();
    const { ws, repository } = Route.useSearch();
    return <SetupHistoryPage productId={productId} ws={ws} repository={repository} />;
  },
});
