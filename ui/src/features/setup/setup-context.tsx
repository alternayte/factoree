import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { SetupStepsSkeleton } from "./setup-skeleton";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getSetupStatus } from "@/api/sdk.gen";
import type { GetSetupStatusResponse } from "@/api/types.gen";
import { CenteredPage } from "@/app/brand";
import { ErrorAlert } from "@/components/layout";
import { isStatus } from "@/lib/api";
import { clearSetupToken, setupToken, writeSetupToken } from "@/lib/setup-token";

export type SetupStatus = GetSetupStatusResponse;

type SetupContextValue = {
  token: string;
  status: SetupStatus;
  setStatus: (status: SetupStatus) => void;
  /** handleAuthError reacts to 401 (wrong token) and 410 (setup complete). It returns true when it did. */
  handleAuthError: (error: unknown) => boolean;
};

const SetupContext = createContext<SetupContextValue | null>(null);

export function useSetup(): SetupContextValue {
  const value = useContext(SetupContext);
  if (!value) throw new Error("useSetup outside SetupGate");
  return value;
}

const statusKey = (token: string | null) => ["setup-status", token] as const;

/**
 * SetupGate asks for the setup token, loads the setup status with it, and gives both to the
 * children. A 401 clears the token and asks again. A 410 means setup is complete, so the browser
 * goes to /sign-in.
 */
export function SetupGate({
  children,
  renderTokenForm,
}: {
  children: ReactNode;
  renderTokenForm: (props: { onSubmit: (token: string) => void; rejected: boolean }) => ReactNode;
}) {
  const [token, setToken] = useState<string | null>(() => setupToken());
  const [rejected, setRejected] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const status = useQuery({
    queryKey: statusKey(token),
    queryFn: async ({ signal }) => (await getSetupStatus({ signal, throwOnError: true })).data,
    enabled: token !== null,
    staleTime: 0,
  });

  const handleAuthError = useCallback(
    (error: unknown) => {
      if (isStatus(error, 401)) {
        clearSetupToken();
        qc.removeQueries({ queryKey: ["setup-status"] });
        setRejected(true);
        setToken(null);
        return true;
      }
      if (isStatus(error, 410)) {
        clearSetupToken();
        void navigate({ to: "/sign-in" });
        return true;
      }
      return false;
    },
    [navigate, qc],
  );

  useEffect(() => {
    if (status.error) handleAuthError(status.error);
  }, [status.error, handleAuthError]);

  const setStatus = useCallback((next: SetupStatus) => qc.setQueryData(statusKey(token), next), [qc, token]);

  const value = useMemo(
    () => (token !== null && status.data ? { token, status: status.data, setStatus, handleAuthError } : null),
    [token, status.data, setStatus, handleAuthError],
  );

  if (token === null) {
    return renderTokenForm({
      rejected,
      onSubmit: (next) => {
        writeSetupToken(next);
        setRejected(false);
        setToken(next);
      },
    });
  }
  if (status.isPending) return <SetupStepsSkeleton />;
  if (status.isError || !value) {
    return (
      <CenteredPage>
        <ErrorAlert error={status.error} title="The setup status did not load" />
      </CenteredPage>
    );
  }
  return <SetupContext.Provider value={value}>{children}</SetupContext.Provider>;
}
