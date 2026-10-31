import { useQuery } from "@tanstack/react-query";
import { getMeOptions } from "@/api/@tanstack/react-query.gen";
import type { GetMeResponse } from "@/api/types.gen";
import { authFetch } from "@/lib/api";

export type Me = GetMeResponse;
export type Membership = Me["memberships"][number];

export function useMe() {
  return useQuery({ ...getMeOptions(), staleTime: 60_000 });
}

/** signInWithLinear starts the better-auth Linear sign-in and leaves the page for Linear. */
export async function signInWithLinear(callbackURL = "/") {
  const result = await authFetch<{ url?: string; redirect?: boolean }>("/sign-in/social", {
    provider: "linear",
    callbackURL,
  });
  if (!result.url) throw new Error("The sign-in returned no Linear URL.");
  window.location.assign(result.url);
}

export async function signOut() {
  await authFetch("/sign-out", {});
}

/** The refusal texts for the ?error= that better-auth adds when it sends the browser back to /sign-in. */
export function signInRefusal(code: string): string {
  switch (code) {
    case "not_a_member":
      return "Your Linear account is not a member of a workspace where Factoree is installed. Ask an admin of that workspace to invite you, or install Factoree in your workspace.";
    case "unable_to_get_user_info":
      return "Factoree could not read your Linear profile. Try again.";
    case "state_mismatch":
    case "please_restart_the_process":
      return "The sign-in expired or started in another tab. Start it again.";
    case "access_denied":
      return "You declined the Linear authorisation.";
    default:
      return code.replaceAll("_", " ");
  }
}
