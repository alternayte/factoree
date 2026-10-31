import { Check } from "lucide-react";
import { useState } from "react";
import { Frame, navList } from "@/app/shell";
import { FinishStep } from "./finish-step";
import { GitHubAppStep } from "./github-app-step";
import { GitHubInstallStep } from "./github-install-step";
import { LinearStep } from "./linear-step";
import { ProductStep } from "./product-step";
import { SandboxStep } from "./sandbox-step";
import { useSetup } from "./setup-context";
import { firstOpenStep, SETUP_STEPS, type SetupStepId } from "./steps";

export function SetupSteps({ linearError }: { linearError?: string }) {
  const { status } = useSetup();
  // A Linear error comes back from the Linear step, so that step opens.
  const [chosen, setChosen] = useState<SetupStepId | null>(linearError ? "linear" : null);
  const active = chosen ?? firstOpenStep(status);

  return (
    <Frame
      narrow
      navLabel="Setup steps"
      nav={
        <ol className={navList}>
          {SETUP_STEPS.map((step, index) => {
            const done = step.done(status);
            const current = active === step.id;
            return (
              <li key={step.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => setChosen(step.id)}
                  aria-current={current ? "step" : undefined}
                  className="nav-link w-full"
                >
                  <span
                    className="step-marker"
                    data-state={current ? "current" : done ? "done" : "upcoming"}
                    aria-hidden
                  >
                    {done ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : index + 1}
                  </span>
                  <span>{step.title}</span>
                  <span className="sr-only">{done ? ", done" : ", not done"}</span>
                </button>
              </li>
            );
          })}
        </ol>
      }
      footer={
        <p className="flex flex-wrap items-baseline gap-x-2 sm:block">
          <span className="t-hint">Public URL</span>
          <span className="block font-mono text-[11px] break-all text-body">{status.publicUrl}</span>
        </p>
      }
    >
      <div key={active}>
        {active === "github-app" ? <GitHubAppStep /> : null}
        {active === "linear" ? <LinearStep linearError={linearError} /> : null}
        {active === "github-install" ? <GitHubInstallStep /> : null}
        {active === "sandbox" ? <SandboxStep /> : null}
        {active === "product" ? <ProductStep /> : null}
        {active === "finish" ? <FinishStep /> : null}
      </div>
    </Frame>
  );
}
