import type { ReactNode } from "react";
import { Badge, PageHeader, Stack } from "@/components/layout";
import { SETUP_STEPS, type SetupStepId } from "./steps";

export { FieldGrid } from "@/components/form";

/** StepFrame is the page of one setup step: where it sits, its title, its state, and its cards. */
export function StepFrame({
  step,
  title,
  done,
  description,
  children,
}: {
  step: SetupStepId;
  title: string;
  done: boolean;
  description?: ReactNode;
  children: ReactNode;
}) {
  const index = SETUP_STEPS.findIndex((s) => s.id === step);
  return (
    <section aria-labelledby="setup-step-title">
      <PageHeader
        titleId="setup-step-title"
        crumb={`setup / step ${index + 1} of ${SETUP_STEPS.length}`}
        title={title}
        description={description}
        actions={done ? <Badge tone="success">done</Badge> : <Badge>to do</Badge>}
      />
      <Stack>{children}</Stack>
    </section>
  );
}

/** Actions holds the buttons of a form and its in-place confirmation. */
export function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3 pt-1">{children}</div>;
}
