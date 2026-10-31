import { createFileRoute } from "@tanstack/react-router";
import { ProductPage } from "@/features/products/product-page";
import { wsSearch } from "@/lib/search";

export const Route = createFileRoute("/_app/products/$productId")({
  validateSearch: wsSearch,
  component: function Product() {
    const { productId } = Route.useParams();
    const { ws } = Route.useSearch();
    return <ProductPage productId={productId} ws={ws} />;
  },
});
