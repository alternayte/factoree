import { RepositorySetupSection } from "./repository-setup-section";
import { SandboxProviderChoice } from "./sandbox-provider-choice";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useId, useMemo, useState } from "react";
import {
  getProductOptions,
  getProductQueryKey,
  listProductSecretsOptions,
  listProductsQueryKey,
} from "@/api/@tanstack/react-query.gen";
import { activateProduct, deleteProduct, putProductSecret, updateProduct } from "@/api/sdk.gen";
import { Button } from "@/components/button";
import { Confirm } from "@/components/confirm";
import { Field, Input, SavedNote, Select, Textarea } from "@/components/form";
import { AllowedDomainsHelp, AutonomyHelp, AutonomyOptions, RiskCapsHelp } from "@/components/policy-help";
import {
  Alert,
  Badge,
  ErrorAlert,
  KeyValue,
  Loading,
  PageHeader,
  Section,
  Skeleton,
  SkeletonCard,
  Stack,
} from "@/components/layout";
import { useMe } from "@/lib/session";
import { formatDate } from "@/lib/utils";
import { levelHelp } from "@/lib/policy-help";
import { AUTONOMY_LEVELS, pickWorkspace, type AutonomyLevel } from "@/lib/workspace";
import { ContextSourcesSection } from "./context-sources-section";
import { ModelWarning, RecentSessionsSection } from "./model-defaults";
import { bodyOf, formOf, LIMITS, type Product, type ProductForm } from "./product-form";
import { SecretsSection, type KeyRequest } from "./secrets-section";
import { AgentsSection } from "./model-picker";

/** docs/specs/skill-registry.md. The Product secret that holds the registry service key. */
const SKILL_REGISTRY_KEY = "SKILL_REGISTRY_KEY";

export function ProductPage({ productId, ws }: { productId: string; ws?: string }) {
  const me = useMe();
  const workspace = pickWorkspace(me.data?.memberships ?? [], ws);
  const linearWorkspaceId = workspace?.linearWorkspaceId ?? "";
  const options = { path: { id: productId }, query: { linearWorkspaceId } };
  const product = useQuery({ ...getProductOptions(options), enabled: Boolean(workspace) });

  const back = (
    <Link to="/products" search={ws ? { ws } : {}} className="hover:text-body">
      products
    </Link>
  );
  return (
    <div>
      {!workspace ? (
        <>
          <PageHeader crumb={back} title="Product" />
          <Alert tone="info">You are a member of no workspace where Factoree is installed.</Alert>
        </>
      ) : null}
      {product.isPending && workspace ? (
        <>
          <Loading label="Loading the product" className="mb-6">
            <Skeleton className="h-2.5 w-28" />
            <Skeleton className="mt-3 h-5 w-48" />
            <Skeleton className="mt-3 h-3 w-64" />
          </Loading>
          <Stack>
            <SkeletonCard fields={3} />
            <SkeletonCard fields={4} />
          </Stack>
        </>
      ) : null}
      {product.error ? (
        <>
          <PageHeader crumb={back} title="Product" />
          <ErrorAlert error={product.error} title="The product did not load" />
        </>
      ) : null}
      {product.data && workspace ? (
        <ProductEditor
          key={product.data.id}
          crumb={back}
          product={product.data}
          linearWorkspaceId={linearWorkspaceId}
          canEdit={workspace.admin}
        />
      ) : null}
    </div>
  );
}

function ProductEditor({
  crumb,
  product,
  linearWorkspaceId,
  canEdit,
}: {
  crumb: React.ReactNode;
  product: Product;
  linearWorkspaceId: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const key = getProductQueryKey({ path: { id: product.id }, query: { linearWorkspaceId } });
  const [form, setForm] = useState<ProductForm>(() => formOf(product));
  const [attempted, setAttempted] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [registryWarning, setRegistryWarning] = useState<string | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(formOf(product));
  // The same query as the secrets section, so the cache answers both.
  const secrets = useQuery(listProductSecretsOptions({ path: { id: product.id }, query: { linearWorkspaceId } }));
  const hasRunnerCredential = secrets.data?.some((secret) => secret.kind === "runner_credential");
  // docs/specs/model-picker.md. Add key in the model picker opens the secrets form with the key name.
  const [keyRequest, setKeyRequest] = useState<KeyRequest | null>(null);
  const secretNames = useMemo(
    () => (secrets.data ? new Set(secrets.data.map((secret) => secret.name)) : null),
    [secrets.data],
  );
  const hasRegistryKey = secrets.data?.some((secret) => secret.name === SKILL_REGISTRY_KEY);

  const save = useMutation({
    mutationFn: async () => {
      const result = bodyOf(form);
      if ("problems" in result) throw new Error(result.problems.join(" "));
      // docs/specs/skill-registry.md. The key is stored first, because the save resolves the
      // registry with it.
      const registryKey = form.skillRegistryKey.trim();
      if (registryKey) {
        await putProductSecret({
          path: { id: product.id, name: SKILL_REGISTRY_KEY },
          query: { linearWorkspaceId },
          body: { value: registryKey, kind: "test", injectIntoImplementer: false },
          throwOnError: true,
        });
      }
      return (
        await updateProduct({
          path: { id: product.id },
          query: { linearWorkspaceId },
          body: result.body,
          throwOnError: true,
        })
      ).data;
    },
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      setForm(formOf(next));
      setRegistryWarning(next.skillRegistryWarning ?? null);
      void qc.invalidateQueries({
        queryKey: listProductSecretsOptions({ path: { id: product.id }, query: { linearWorkspaceId } }).queryKey,
      });
      setAttempted(false);
      void qc.invalidateQueries({ queryKey: listProductsQueryKey({ query: { linearWorkspaceId } }) });
    },
  });

  const remove = useMutation({
    mutationFn: async () =>
      deleteProduct({ path: { id: product.id }, query: { linearWorkspaceId }, throwOnError: true }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: listProductsQueryKey({ query: { linearWorkspaceId } }) });
      void navigate({ to: "/products", search: { ws: linearWorkspaceId } });
    },
  });

  const checked = bodyOf(form);
  const problems = attempted && "problems" in checked ? checked.problems : [];

  const set = <K extends keyof ProductForm>(k: K, value: ProductForm[K]) => setForm((f) => ({ ...f, [k]: value }));
  const disabled = !canEdit;

  return (
    <>
      <PageHeader
        crumb={
          <>
            {crumb} / {product.slug}
          </>
        }
        title={product.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              Linear team <span className="font-mono text-body">{product.linearTeamKey}</span>
            </span>
            {product.status === "active" ? <Badge tone="success">active</Badge> : <Badge tone="warning">pending</Badge>}
          </span>
        }
        actions={
          canEdit ? (
            <Button variant="danger" onClick={() => setDeleting(true)}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              Delete
            </Button>
          ) : null
        }
      />
      {!canEdit ? (
        <Alert tone="info" className="mb-4">
          You are a member of this workspace. A Linear workspace admin changes this product.
        </Alert>
      ) : null}
      {product.status === "pending" ? (
        <ActivateProduct product={product} linearWorkspaceId={linearWorkspaceId} canEdit={canEdit} />
      ) : null}
      {/* docs/specs/run-visibility.md. On a desktop the sections sit in two columns. */}
      <form
        id="product-form"
        className="stagger grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start"
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);
          if ("problems" in checked) return;
          save.mutate();
        }}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="General">
            <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
              <Field label="Name">
                {(props) => (
                  <Input
                    {...props}
                    required
                    disabled={disabled}
                    value={form.name}
                    onChange={(e) => set("name", e.target.value)}
                  />
                )}
              </Field>
              <Field label="Organization skills repository" hint="owner/repository. Empty for none.">
                {(props) => (
                  <Input
                    {...props}
                    mono
                    disabled={disabled}
                    placeholder="acme/skills"
                    value={form.organizationSkillsRepository}
                    onChange={(e) => set("organizationSkillsRepository", e.target.value)}
                  />
                )}
              </Field>
            </div>
            {/* The warning follows the saved model, so it never flickers while the operator types. */}
            {product.defaultRunner === "opencode" && product.model === null && hasRunnerCredential !== undefined ? (
              <ModelWarning hasRunnerCredential={hasRunnerCredential} className="mt-4" />
            ) : null}
          </Section>

          <AgentsSection
            form={form}
            setForm={setForm}
            disabled={disabled}
            secretNames={secretNames}
            onAddKey={(name) => setKeyRequest({ name, nonce: Date.now() })}
          />

          <Section
            title="Policy"
            description="The default autonomy, the risk caps per Linear label, and the domains agents may reach."
          >
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-4">
                <Field label="Default autonomy" help={<AutonomyHelp />} hint={levelHelp(form.defaultAutonomy).detail}>
                  {(props) => (
                    <Select
                      {...props}
                      disabled={disabled}
                      value={form.defaultAutonomy}
                      onChange={(e) => set("defaultAutonomy", e.target.value as AutonomyLevel)}
                    >
                      <AutonomyOptions />
                    </Select>
                  )}
                </Field>
                <RiskCaps value={form.riskCaps} onChange={(caps) => set("riskCaps", caps)} disabled={disabled} />
              </div>
              <Field
                label="Allowed domains"
                help={<AllowedDomainsHelp />}
                hint="One domain per line. Agents reach only these hosts."
              >
                {(props) => (
                  <Textarea
                    {...props}
                    rows={7}
                    mono
                    disabled={disabled}
                    value={form.allowedDomains}
                    onChange={(e) => set("allowedDomains", e.target.value)}
                  />
                )}
              </Field>
            </div>
          </Section>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Section
            title="Limits"
            description="Runs over the parallel limit wait in a queue and start in delegation order."
          >
            <div className="grid grid-cols-2 items-end gap-x-4 gap-y-3.5 sm:grid-cols-4">
              {LIMITS.map((limit) => (
                <Field key={limit.key} label={limit.label} hint={`${limit.min} to ${limit.max}`}>
                  {(props) => (
                    <Input
                      {...props}
                      type="number"
                      required
                      min={limit.min}
                      max={limit.max}
                      step={1}
                      disabled={disabled}
                      value={String(form[limit.key])}
                      onChange={(e) => set(limit.key, e.target.value as never)}
                    />
                  )}
                </Field>
              ))}
            </div>
          </Section>

          <Section
            title="Sandbox providers"
            description="The providers this product's runs may use. With none chosen, runs may use every enabled provider. Choose your own hosts only to keep this product's code and secrets off a cloud provider."
          >
            <SandboxProviderChoice
              value={form.sandboxProviderIds}
              disabled={disabled}
              onChange={(next) => set("sandboxProviderIds", next)}
            />
          </Section>

          <Section
            title="App change issues"
            description="When a setup pull request merges, Factoree creates and delegates a Linear issue for the app changes its report names. When every one has ended, Factoree runs the setup again."
          >
            <Field label="Issues per merged setup">
              {(props) => (
                <Select
                  {...props}
                  disabled={disabled}
                  value={form.appChangeIssues}
                  onChange={(e) => set("appChangeIssues", e.target.value as ProductForm["appChangeIssues"])}
                >
                  <option value="one_per_change">One per change</option>
                  <option value="one_for_all">One for all changes</option>
                </Select>
              )}
            </Field>
          </Section>

          <Section
            title="Skill registry"
            description="Factoree resolves the registry on the worker for each run, checks every digest, and gives the skills to the implementer. A Skael server is the one registry kind."
          >
            <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
              <Field label="Registry URL" hint="Empty for no registry.">
                {(props) => (
                  <Input
                    {...props}
                    mono
                    disabled={disabled}
                    placeholder="https://skael.example.com"
                    value={form.skillRegistryUrl}
                    onChange={(e) => set("skillRegistryUrl", e.target.value)}
                  />
                )}
              </Field>
              <Field label="Set" hint="Empty gives every released skill.">
                {(props) => (
                  <Input
                    {...props}
                    mono
                    disabled={disabled}
                    placeholder="all released skills"
                    value={form.skillRegistrySet}
                    onChange={(e) => set("skillRegistrySet", e.target.value)}
                  />
                )}
              </Field>
              <Field
                label="Service key"
                hint={
                  hasRegistryKey
                    ? "Stored. Enter a new key to replace it."
                    : "Stored as the secret SKILL_REGISTRY_KEY. It never reaches a sandbox."
                }
              >
                {(props) => (
                  <Input
                    {...props}
                    type="password"
                    autoComplete="off"
                    mono
                    disabled={disabled}
                    value={form.skillRegistryKey}
                    onChange={(e) => set("skillRegistryKey", e.target.value)}
                  />
                )}
              </Field>
            </div>
            {registryWarning ? (
              <Alert tone="warning" className="mt-4">
                {registryWarning}
              </Alert>
            ) : null}
          </Section>
        </div>

        {problems.length > 0 ? (
          <Alert tone="danger" title="Fix these before you save" className="lg:col-span-2">
            <ul className="list-disc pl-4">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        <ErrorAlert error={save.error} className="lg:col-span-2" />
      </form>

      <RepositorySetupSection
        productId={product.id}
        linearWorkspaceId={linearWorkspaceId}
        allowedDomains={product.allowedDomains}
        canEdit={canEdit}
      />

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          <SecretsSection
            productId={product.id}
            linearWorkspaceId={linearWorkspaceId}
            canEdit={canEdit}
            keyRequest={keyRequest}
          />
          <RecentSessionsSection productId={product.id} linearWorkspaceId={linearWorkspaceId} />
        </div>
        <ContextSourcesSection productId={product.id} linearWorkspaceId={linearWorkspaceId} canEdit={canEdit} />
      </div>

      <Section title="Details" className="mt-4">
        <KeyValue
          items={[
            { label: "Product id", value: product.id },
            { label: "Linear team id", value: product.linearTeamId },
            { label: "Created", value: formatDate(product.createdAt) },
          ]}
        />
      </Section>

      {/* The save bar ends the page, so it floats at the bottom of the window until the page ends. Its
          submit button reaches the form through the form attribute. */}
      {canEdit ? (
        <div className="sticky bottom-0 z-10 -mx-1 mt-4 flex flex-wrap items-center gap-3 border-t border-hairline bg-canvas px-1 py-3">
          {/* One primary action per view: a pending product's primary action is Activate. */}
          <Button
            type="submit"
            form="product-form"
            variant={product.status === "pending" ? "secondary" : "primary"}
            disabled={!dirty}
            mutation={save}
          >
            Save product
          </Button>
          <Button variant="ghost" disabled={!dirty || save.isPending} onClick={() => setForm(formOf(product))}>
            Discard changes
          </Button>
          <SavedNote show={save.isSuccess && !dirty} />
          <span className="t-hint ml-auto">Updated {formatDate(product.updatedAt)}</span>
        </div>
      ) : null}

      <Confirm
        open={deleting}
        title={`Delete ${product.name}?`}
        confirmLabel="Delete product"
        mutation={remove}
        onCancel={() => setDeleting(false)}
        onConfirm={() => remove.mutate()}
      >
        Factoree stops taking work from the Linear team {product.linearTeamKey}. The API refuses the delete while the
        product has runs.
        {remove.error ? <ErrorAlert error={remove.error} className="mt-3" /> : null}
      </Confirm>
    </>
  );
}

function RiskCaps({
  value,
  onChange,
  disabled,
}: {
  value: ProductForm["riskCaps"];
  onChange: (caps: ProductForm["riskCaps"]) => void;
  disabled: boolean;
}) {
  const labelId = useId();
  const update = (index: number, patch: Partial<ProductForm["riskCaps"][number]>) =>
    onChange(value.map((cap, i) => (i === index ? { ...cap, ...patch } : cap)));
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-2">
      <div className="mb-1.5 flex items-center gap-1">
        <span id={labelId} className="t-label">
          Risk caps
        </span>
        <RiskCapsHelp />
      </div>
      <p className="t-hint">A Linear label caps the autonomy of a run that carries it. Labels match without case.</p>
      {value.length === 0 ? <p className="t-hint">No risk caps.</p> : null}
      {value.map((cap, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={`Risk cap ${index + 1} label`}
            mono
            className="flex-1"
            placeholder="label"
            disabled={disabled}
            value={cap.label}
            onChange={(e) => update(index, { label: e.target.value })}
          />
          <Select
            aria-label={`Risk cap ${index + 1} level`}
            className="w-40"
            disabled={disabled}
            value={cap.level}
            onChange={(e) => update(index, { level: e.target.value as AutonomyLevel })}
          >
            {AUTONOMY_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level} · {levelHelp(level).name}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove risk cap ${cap.label || index + 1}`}
            disabled={disabled}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        className="self-start"
        disabled={disabled}
        onClick={() => onChange([...value, { label: "", level: "L1" }])}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add risk cap
      </Button>
    </div>
  );
}

function ActivateProduct({
  product,
  linearWorkspaceId,
  canEdit,
}: {
  product: Product;
  linearWorkspaceId: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [level, setLevel] = useState<AutonomyLevel>("L2");
  const activate = useMutation({
    mutationFn: async () =>
      (
        await activateProduct({
          path: { id: product.id },
          query: { linearWorkspaceId },
          body: { defaultAutonomy: level },
          throwOnError: true,
        })
      ).data,
    onSuccess: (next) => {
      qc.setQueryData(getProductQueryKey({ path: { id: product.id }, query: { linearWorkspaceId } }), next);
      void qc.invalidateQueries({ queryKey: listProductsQueryKey({ query: { linearWorkspaceId } }) });
    },
  });
  return (
    <Alert tone="warning" title="This product is pending" className="mb-4">
      <p>Factoree takes no work from the team until the product is active.</p>
      {canEdit ? (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Default autonomy" help={<AutonomyHelp />} className="min-w-0 flex-1 basis-64">
            {(props) => (
              <Select {...props} value={level} onChange={(e) => setLevel(e.target.value as AutonomyLevel)}>
                <AutonomyOptions />
              </Select>
            )}
          </Field>
          <Button variant="primary" mutation={activate} onClick={() => activate.mutate()}>
            Activate
          </Button>
        </div>
      ) : null}
      <ErrorAlert error={activate.error} className="mt-2" />
    </Alert>
  );
}
