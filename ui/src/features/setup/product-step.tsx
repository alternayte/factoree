import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createSetupProduct, listSetupLinearTeams } from "@/api/sdk.gen";
import type { CreateSetupProductData } from "@/api/types.gen";
import { Button } from "@/components/button";
import { Field, Input, Select } from "@/components/form";
import { Alert, ErrorAlert, Section } from "@/components/layout";
import { ApiError } from "@/lib/api";
import { AutonomyHelp, AutonomyOptions } from "@/components/policy-help";
import { levelHelp } from "@/lib/policy-help";
import { type AutonomyLevel } from "@/lib/workspace";
import { CLAUDE_MODELS, DEFAULT_MODEL } from "@/features/products/model-defaults";
import type { Runner } from "@/features/products/product-form";
import { Actions, FieldGrid, StepFrame } from "./step-frame";
import { useSetup } from "./setup-context";

const SLUG_PATTERN = "[a-z0-9][a-z0-9\\-]*";
const MODEL_PATTERN = "[^\\s/]+/\\S+";
const KEY_NAME_PATTERN = "[A-Z][A-Z0-9_]*";

export function ProductStep() {
  const { status, handleAuthError, token } = useSetup();
  const qc = useQueryClient();
  const ready = status.linearInstall.done;
  const teams = useQuery({
    queryKey: ["setup-linear-teams", token],
    queryFn: async ({ signal }) => (await listSetupLinearTeams({ signal, throwOnError: true })).data,
    enabled: ready,
  });

  const [teamKey, setTeamKey] = useState("");
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [autonomy, setAutonomy] = useState<AutonomyLevel>("L2");
  const [runner, setRunner] = useState<Runner>("opencode");
  const [model, setModel] = useState("");
  const [keyName, setKeyName] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async (body: CreateSetupProductData["body"]) =>
      (await createSetupProduct({ body, throwOnError: true })).data,
    onSuccess: (product) => {
      setCreated(product.slug);
      void qc.invalidateQueries({ queryKey: ["setup-status"] });
      setKeyValue("");
    },
    onError: handleAuthError,
  });

  function chooseTeam(key: string) {
    const team = teams.data?.find((t) => t.key === key);
    setTeamKey(key);
    // The slug and the name start from the team. The operator can change both.
    if (team && !slug) setSlug(team.key.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
    if (team && !name) setName(team.name);
  }

  function submit() {
    if (Boolean(keyName.trim()) !== Boolean(keyValue.trim())) {
      setLocalError("Enter the model key name and its value together, or neither.");
      return;
    }
    setLocalError(null);
    const body: CreateSetupProductData["body"] = {
      linearTeamKey: teamKey,
      slug: slug.trim(),
      name: name.trim(),
      defaultAutonomy: autonomy,
      runner,
      model: model.trim() || null,
    };
    if (keyName.trim()) {
      body.modelKeyName = keyName.trim();
      body.modelKeyValue = keyValue.trim();
    }
    create.mutate(body);
  }

  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors : {};

  return (
    <StepFrame
      step="product"
      title="First product"
      done={status.product.done}
      description="A product maps one Linear team to Factoree, with its model and autonomy. Add more products after setup."
    >
      {!ready || status.product.slugs.length > 0 || created || teams.error ? (
        <div className="flex flex-col gap-3">
          {!ready ? <Alert tone="warning">Install the Linear app first. The team list comes from Linear.</Alert> : null}
          {status.product.slugs.length > 0 ? (
            <Alert tone="success">Products: {status.product.slugs.join(", ")}.</Alert>
          ) : null}
          {created ? <Alert tone="success">Created the product {created}.</Alert> : null}
          <ErrorAlert error={teams.error} title="The Linear teams did not load" />
        </div>
      ) : null}
      <Section title={status.product.done ? "Another product" : "Product"}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FieldGrid>
            <Field label="Linear team" errors={fieldErrors.linearTeamKey}>
              {(props) => (
                <Select
                  {...props}
                  required
                  disabled={!ready || teams.isPending}
                  value={teamKey}
                  onChange={(e) => chooseTeam(e.target.value)}
                >
                  <option value="">{teams.isPending && ready ? "Loading teams…" : "Choose a team"}</option>
                  {teams.data?.map((team) => (
                    <option key={team.id} value={team.key}>
                      {team.name} ({team.key})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Default autonomy"
              help={<AutonomyHelp />}
              hint={`${levelHelp(autonomy).detail} L2 is the usual start.`}
              errors={fieldErrors.defaultAutonomy}
            >
              {(props) => (
                <Select {...props} value={autonomy} onChange={(e) => setAutonomy(e.target.value as AutonomyLevel)}>
                  <AutonomyOptions />
                </Select>
              )}
            </Field>
            <Field label="Slug" hint="Lower case letters, digits and dashes." errors={fieldErrors.slug}>
              {(props) => (
                <Input
                  {...props}
                  mono
                  required
                  pattern={SLUG_PATTERN}
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                />
              )}
            </Field>
            <Field label="Name" errors={fieldErrors.name}>
              {(props) => <Input {...props} required value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Field
              label="Runner"
              hint="The coding agent of every role. Change it per role later."
              errors={fieldErrors.runner}
            >
              {(props) => (
                <Select {...props} value={runner} onChange={(e) => setRunner(e.target.value as Runner)}>
                  <option value="opencode">opencode</option>
                  <option value="claude">Claude Code</option>
                </Select>
              )}
            </Field>
            <Field
              label="Model (optional)"
              hint={
                runner === "opencode"
                  ? `provider/model, for example deepseek/deepseek-chat. Default: ${DEFAULT_MODEL.opencode}.`
                  : `${CLAUDE_MODELS.join(", ")} or a full claude-* id. Default: ${DEFAULT_MODEL.claude}.`
              }
              errors={fieldErrors.model}
            >
              {(props) => (
                <Input
                  {...props}
                  mono
                  {...(runner === "opencode" ? { pattern: MODEL_PATTERN } : {})}
                  placeholder={runner === "opencode" ? "provider/model" : "sonnet"}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Model key name (optional)"
              hint={runner === "opencode" ? "For example DEEPSEEK_API_KEY." : "ANTHROPIC_API_KEY."}
              errors={fieldErrors.modelKeyName}
            >
              {(props) => (
                <Input
                  {...props}
                  mono
                  pattern={KEY_NAME_PATTERN}
                  autoComplete="off"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value.toUpperCase())}
                />
              )}
            </Field>
            <Field label="Model key value (optional)" errors={fieldErrors.modelKeyValue}>
              {(props) => (
                <Input
                  {...props}
                  mono
                  type="password"
                  autoComplete="off"
                  value={keyValue}
                  onChange={(e) => setKeyValue(e.target.value)}
                />
              )}
            </Field>
          </FieldGrid>
          {localError ? <Alert tone="danger">{localError}</Alert> : null}
          <ErrorAlert error={create.error} />
          <Actions>
            <Button
              type="submit"
              variant={status.product.done ? "secondary" : "primary"}
              disabled={!ready || !teamKey}
              mutation={create}
            >
              {status.product.done ? "Create another product" : "Create the product"}
            </Button>
          </Actions>
        </form>
      </Section>
    </StepFrame>
  );
}
