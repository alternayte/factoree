import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { putSandbox } from "@/api/sdk.gen";
import type { PutSandboxData } from "@/api/types.gen";
import { Button } from "@/components/button";
import { Alert, ErrorAlert, Section } from "@/components/layout";
import { ApiError } from "@/lib/api";
import {
  emptySandboxForm,
  parseMaxLive,
  parseSize,
  PROVIDER_LABELS,
  SandboxFields,
  type SandboxForm,
  type SandboxProvider,
} from "@/features/settings/sandbox-fields";
import { Actions, StepFrame } from "./step-frame";
import { useSetup } from "./setup-context";

export function SandboxStep() {
  const { status, setStatus, handleAuthError } = useSetup();
  const current = status.sandbox.provider as SandboxProvider | null;
  const [form, setForm] = useState<SandboxForm>({ ...emptySandboxForm, provider: current ?? "kiln" });
  const [localError, setLocalError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (body: PutSandboxData["body"]) => (await putSandbox({ body, throwOnError: true })).data,
    onSuccess: (next) => {
      setStatus(next);
      setForm((f) => ({ ...f, apiKey: "", registryToken: "" }));
    },
    onError: handleAuthError,
  });

  function submit() {
    const maxLive = parseMaxLive(form.maxLive);
    if (maxLive === undefined) {
      setLocalError("The live sandbox limit must be a whole number above 0.");
      return;
    }
    const size = parseSize(form);
    if (typeof size === "string") {
      setLocalError(size);
      return;
    }
    setLocalError(null);
    // The API patches: an absent field keeps the stored value. Setup sends only what the operator entered.
    const body: PutSandboxData["body"] = { provider: form.provider };
    if (form.url.trim() && form.provider !== "local") body.url = form.url.trim();
    if (form.apiKey.trim() && form.provider !== "local") body.apiKey = form.apiKey.trim();
    if (form.image.trim()) body.image = form.image.trim();
    if (form.registryUsername.trim()) body.registryUsername = form.registryUsername.trim();
    if (form.registryToken.trim()) body.registryToken = form.registryToken.trim();
    if (maxLive !== null) body.maxLive = maxLive;
    if (form.provider === "kiln" && size.vcpus !== null) body.vcpus = size.vcpus;
    if (form.provider === "kiln" && size.memoryMb !== null) body.memoryMb = size.memoryMb;
    save.mutate(body);
  }

  return (
    <StepFrame
      step="sandbox"
      title="Sandbox provider"
      done={status.sandbox.done}
      description="Agents run in sandboxes of this provider. One provider serves the whole install."
    >
      {current ? (
        <Alert tone="success">
          Factoree uses {PROVIDER_LABELS[current] ?? current}. Save again to change it; empty fields keep the stored
          values.
        </Alert>
      ) : null}
      <Section title="Provider">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <SandboxFields
            value={form}
            onChange={setForm}
            localAllowed={status.sandbox.localAllowed}
            pinnedImage={status.sandbox.pinnedImage}
            defaultSize={status.sandbox.defaultSize}
            stored={
              current ? { apiKey: current !== "local", registryToken: false, image: status.sandbox.done } : undefined
            }
            fieldErrors={save.error instanceof ApiError ? save.error.fieldErrors : {}}
          />
          {localError ? <Alert tone="danger">{localError}</Alert> : null}
          <ErrorAlert error={save.error} />
          <Actions>
            <Button type="submit" variant={status.sandbox.done ? "secondary" : "primary"} mutation={save}>
              Save the sandbox provider
            </Button>
          </Actions>
        </form>
      </Section>
    </StepFrame>
  );
}
