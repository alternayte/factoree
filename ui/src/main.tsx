import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, parseSearchWith, RouterProvider, stringifySearchWith } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "@/lib/api";
import { routeTree } from "./routeTree.gen";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 4xx answer does not change on a retry. A network error or a 5xx gets two more tries.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  // The router cross-fades the main area with the View Transitions API where the browser has it.
  defaultViewTransition: true,
  scrollRestoration: false,
  // Every search value is a plain string. GitHub and Linear return codes and ids that JSON parsing
  // would turn into numbers and round.
  parseSearch: parseSearchWith((value) => value),
  stringifySearch: stringifySearchWith(String, (value) => value),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
