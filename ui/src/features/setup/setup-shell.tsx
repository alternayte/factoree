import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { getSetupStateOptions } from "@/api/@tanstack/react-query.gen";
import { CenteredPage } from "@/app/brand";
import { Alert, ErrorAlert, Loading, Skeleton } from "@/components/layout";
import { SetupGate } from "./setup-context";
import { TokenForm } from "./token-form";

/**
 * SetupShell checks that setup is still open, then asks for the token and loads the status.
 * The step list draws its own frame. A centered page holds the GitHub return screens.
 */
export function SetupShell({ children, centered = false }: { children: ReactNode; centered?: boolean }) {
  const state = useQuery({ ...getSetupStateOptions(), staleTime: 0 });
  if (state.isPending) {
    return (
      <CenteredPage>
        <CardSkeleton label="Loading the setup state" />
      </CenteredPage>
    );
  }
  if (state.isError) {
    return (
      <CenteredPage>
        <ErrorAlert error={state.error} title="The setup state did not load" />
      </CenteredPage>
    );
  }
  if (state.data.completed) {
    return (
      <CenteredPage>
        <Alert tone="info" title="Setup is complete">
          <Link to="/sign-in" className="link">
            Sign in with Linear
          </Link>{" "}
          to change the settings.
        </Alert>
      </CenteredPage>
    );
  }
  return (
    <SetupGate
      renderTokenForm={(props) => (
        <CenteredPage>
          <TokenForm {...props} />
        </CenteredPage>
      )}
    >
      {centered ? <CenteredPage>{children}</CenteredPage> : children}
    </SetupGate>
  );
}

/** CardSkeleton has the shape of the centered card: a title, a sentence and a control. */
export function CardSkeleton({ label }: { label: string }) {
  return (
    <Loading label={label} className="card p-6">
      <Skeleton className="h-2.5 w-24" />
      <Skeleton className="mt-3 h-5 w-40" />
      <Skeleton className="mt-4 h-3 w-full" />
      <Skeleton className="mt-2 h-3 w-3/4" />
      <Skeleton className="mt-6 h-9 w-full" />
    </Loading>
  );
}
