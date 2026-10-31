import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Alert, ErrorAlert, Loading, Skeleton } from "@/components/layout";
import type { SetupStatus } from "./setup-context";
import { useSetup } from "./setup-context";

/**
 * GitHubReturn finishes a GitHub redirect: it posts once what GitHub returned, stores the new
 * status, and goes back to /setup. A failure stays on screen with a way back.
 */
export function GitHubReturn({
  label,
  missing,
  run,
}: {
  label: string;
  missing: string | null;
  run: () => Promise<SetupStatus>;
}) {
  const { setStatus, handleAuthError } = useSetup();
  const navigate = useNavigate();
  const started = useRef(false);
  const mutation = useMutation({
    mutationFn: run,
    onSuccess: (next) => {
      setStatus(next);
      void navigate({ to: "/setup", replace: true });
    },
    onError: handleAuthError,
  });

  useEffect(() => {
    // React StrictMode runs effects twice in development. GitHub codes work once.
    if (missing !== null || started.current) return;
    started.current = true;
    mutation.mutate();
  }, [missing, mutation]);

  return (
    <div className="card enter flex flex-col gap-4 p-6">
      <div>
        <p className="t-crumb">setup / github</p>
        <h1 className="t-title mt-2">{label}</h1>
      </div>
      {missing ? <Alert tone="danger">{missing}</Alert> : null}
      {mutation.isPending ? (
        <Loading label="Saving what GitHub returned">
          <p className="text-sm text-mute">Saving what GitHub returned.</p>
          <Skeleton className="mt-3 h-3 w-full" />
          <Skeleton className="mt-2 h-3 w-2/3" />
        </Loading>
      ) : null}
      <ErrorAlert error={mutation.error} />
      {missing || mutation.isError ? (
        <Link to="/setup" className="link text-sm">
          Back to setup
        </Link>
      ) : null}
    </div>
  );
}
