import type { SetupStatus } from "./setup-context";

export type SetupStepId = "github-app" | "linear" | "github-install" | "sandbox" | "product" | "finish";

export const SETUP_STEPS: { id: SetupStepId; title: string; done: (status: SetupStatus) => boolean }[] = [
  { id: "github-app", title: "GitHub App", done: (s) => s.githubApp.done },
  { id: "linear", title: "Linear app", done: (s) => s.linearApp.done && s.linearInstall.done },
  { id: "github-install", title: "GitHub App install", done: (s) => s.githubInstall.done },
  { id: "sandbox", title: "Sandbox provider", done: (s) => s.sandbox.done },
  { id: "product", title: "First product", done: (s) => s.product.done },
  { id: "finish", title: "Finish", done: (s) => s.completed },
];

export function firstOpenStep(status: SetupStatus): SetupStepId {
  return SETUP_STEPS.find((step) => !step.done(status))?.id ?? "finish";
}
