import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { CenteredPage } from "@/app/brand";
import { AppShell, AppShellSkeleton } from "@/app/shell";
import { Button } from "@/components/button";
import { ErrorAlert } from "@/components/layout";
import { isStatus, onUnauthorized } from "@/lib/api";
import { useMe } from "@/lib/session";

export const Route = createFileRoute("/_app")({
  component: SignedInLayout,
});

/** Every settings page needs a session. A 401 from any admin call sends the browser to /sign-in. */
function SignedInLayout() {
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const unauthorized = isStatus(me.error, 401);

  useEffect(
    () =>
      onUnauthorized(() => {
        qc.clear();
        void navigate({ to: "/sign-in" });
      }),
    [navigate, qc],
  );

  useEffect(() => {
    if (unauthorized) void navigate({ to: "/sign-in" });
  }, [unauthorized, navigate]);

  if (me.isPending || unauthorized) {
    return <AppShellSkeleton />;
  }
  if (me.isError) {
    return (
      <CenteredPage>
        <ErrorAlert title="Your account did not load" error={me.error} />
        <Button className="mt-3" onClick={() => void me.refetch()} pending={me.isFetching}>
          Retry
        </Button>
      </CenteredPage>
    );
  }
  return (
    <AppShell me={me.data}>
      <Outlet />
    </AppShell>
  );
}
