import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSetupStateOptions } from "@/api/@tanstack/react-query.gen";

// The start page decides: setup until it completes, then the product settings.
export const Route = createFileRoute("/")({
  beforeLoad: async ({ context }) => {
    const state = await context.queryClient.fetchQuery({ ...getSetupStateOptions(), staleTime: 0 });
    throw redirect({ to: state.completed ? "/products" : "/setup" });
  },
});
