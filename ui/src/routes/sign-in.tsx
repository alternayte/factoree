import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { getSetupStateOptions } from "@/api/@tanstack/react-query.gen";
import { CenteredPage } from "@/app/brand";
import { Button } from "@/components/button";
import { Alert, ErrorAlert, Loading, Skeleton } from "@/components/layout";
import { signInRefusal, signInWithLinear } from "@/lib/session";

type Search = { error?: string };

export const Route = createFileRoute("/sign-in")({
  validateSearch: (search: Record<string, unknown>): Search =>
    typeof search.error === "string" && search.error.length > 0 ? { error: search.error } : {},
  component: SignInPage,
});

function SignInPage() {
  const { error } = Route.useSearch();
  const state = useQuery(getSetupStateOptions());
  const signIn = useMutation({ mutationFn: () => signInWithLinear("/") });

  return (
    <CenteredPage>
      <div className="card enter">
        <div className="p-6">
          <p className="t-crumb">operator console</p>
          <h1 className="t-title mt-2">Sign in</h1>
          <p className="mt-2 text-sm text-mute">
            Factoree admits members of a Linear workspace where it is installed. A Linear workspace admin is a Factoree
            admin.
          </p>
          <div className="mt-5 flex flex-col gap-3 empty:hidden">
            {error ? (
              <Alert tone="danger" title="Factoree refused the sign-in">
                {signInRefusal(error)}
              </Alert>
            ) : null}
            {state.isPending ? (
              <Loading label="Loading the setup state">
                <Skeleton className="h-10 w-full" />
              </Loading>
            ) : null}
            {state.data && !state.data.completed ? (
              <Alert tone="warning" title="Setup is not complete">
                Sign-in works after setup.{" "}
                <Link to="/setup" className="link">
                  Continue setup
                </Link>
              </Alert>
            ) : null}
            <ErrorAlert error={state.error} />
            <ErrorAlert error={signIn.error} />
          </div>
          <Button
            variant="primary"
            className="mt-5 w-full"
            mutation={signIn}
            disabled={state.data?.completed === false}
            onClick={() => signIn.mutate()}
          >
            Sign in with Linear
          </Button>
        </div>
      </div>
    </CenteredPage>
  );
}
