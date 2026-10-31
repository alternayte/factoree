import { createFileRoute } from "@tanstack/react-router";
import { ProductsPage } from "@/features/products/products-page";
import { wsSearch } from "@/lib/search";

export const Route = createFileRoute("/_app/products/")({
  validateSearch: wsSearch,
  component: function Products() {
    const { ws } = Route.useSearch();
    return <ProductsPage ws={ws} />;
  },
});
