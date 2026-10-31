import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { completeSetup } from "@/api/sdk.gen";
import { Button } from "@/components/button";
import { Alert, ErrorAlert, Section } from "@/components/layout";
import { clearSetupToken } from "@/lib/setup-token";
import { Actions, StepFrame } from "./step-frame";
import { useSetup } from "./setup-context";
import { SETUP_STEPS } from "./steps";

export function FinishStep() {
  const { status, handleAuthError } = useSetup();
  const navigate = useNavigate();
  const open = SETUP_STEPS.filter((step) => step.id !== "finish" && !step.done(status)).map((step) => step.title);

  const complete = useMutation({
    mutationFn: async () => (await completeSetup({ throwOnError: true })).data,
    onSuccess: () => {
      clearSetupToken();
      void navigate({ to: "/sign-in" });
    },
    onError: handleAuthError,
  });

  return (
    <StepFrame
      step="finish"
      title="Finish"
      done={status.completed}
      description="Finishing ends setup. The setup token stops working, and you sign in with Linear from then on."
    >
      <Section title="Finish setup">
        <div className="flex flex-col gap-3.5">
          {open.length > 0 ? <Alert tone="warning">These steps are not done: {open.join(", ")}.</Alert> : null}
          <ErrorAlert error={complete.error} />
          <Actions>
            <Button variant="primary" disabled={open.length > 0} mutation={complete} onClick={() => complete.mutate()}>
              Finish setup
            </Button>
          </Actions>
        </div>
      </Section>
    </StepFrame>
  );
}
