import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { getProductOptions, getProductQueryKey, listProductsQueryKey } from "@/api/@tanstack/react-query.gen";
import { activateProduct, deleteProduct, updateProduct } from "@/api/sdk.gen";
import { Button } from "@/components/button";
import { Confirm } from "@/components/confirm";
import { Field, Input, SavedNote, Select, Textarea } from "@/components/form";
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
import { AUTONOMY_LEVELS, EFFORT_ROLES, EFFORT_SUGGESTIONS, pickWorkspace, type AutonomyLevel } from "@/lib/workspace";
import { bodyOf, formOf, LIMITS, type Product, type ProductForm } from "./product-form";
import { SecretsSection } from "./secrets-section";

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
    <div className="max-w-[640px]">
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
  const dirty = JSON.stringify(form) !== JSON.stringify(formOf(product));

  const save = useMutation({
    mutationFn: async () => {
      const result = bodyOf(form);
      if ("problems" in result) throw new Error(result.problems.join(" "));
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
      <form
        className="stagger flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);
          if ("problems" in checked) return;
          save.mutate();
        }}
      >
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
            <Field label="Model" hint="provider/model. Empty uses the runner default.">
              {(props) => (
                <Input
                  {...props}
                  mono
                  disabled={disabled}
                  placeholder="provider/model"
                  value={form.model}
                  onChange={(e) => set("model", e.target.value)}
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
        </Section>

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

        <EffortSection form={form} setForm={setForm} disabled={disabled} />

        <Section
          title="Policy"
          description="The default autonomy, the risk caps per Linear label, and the domains agents may reach."
        >
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-4">
              <Field label="Default autonomy">
                {(props) => (
                  <Select
                    {...props}
                    className="w-32"
                    disabled={disabled}
                    value={form.defaultAutonomy}
                    onChange={(e) => set("defaultAutonomy", e.target.value as AutonomyLevel)}
                  >
                    {AUTONOMY_LEVELS.map((level) => (
                      <option key={level}>{level}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <RiskCaps value={form.riskCaps} onChange={(caps) => set("riskCaps", caps)} disabled={disabled} />
            </div>
            <Field label="Allowed domains" hint="One domain per line. Agents reach only these hosts.">
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

        {problems.length > 0 ? (
          <Alert tone="danger" title="Fix these before you save">
            <ul className="list-disc pl-4">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        <ErrorAlert error={save.error} />
        {canEdit ? (
          <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-3 border-t border-hairline bg-canvas px-1 py-3">
            {/* One primary action per view: a pending product's primary action is Activate. */}
            <Button
              type="submit"
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
      </form>

      <div className="mt-4">
        <SecretsSection productId={product.id} linearWorkspaceId={linearWorkspaceId} canEdit={canEdit} />
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

function EffortSection({
  form,
  setForm,
  disabled,
}: {
  form: ProductForm;
  setForm: React.Dispatch<React.SetStateAction<ProductForm>>;
  disabled: boolean;
}) {
  const listId = useId();
  return (
    <Section
      title="Effort per role"
      description="The reasoning effort each agent role asks of the model. Empty uses the default."
    >
      <datalist id={listId}>
        {EFFORT_SUGGESTIONS.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5 sm:grid-cols-4">
        {EFFORT_ROLES.map((role) => (
          <Field key={role} label={role[0]!.toUpperCase() + role.slice(1)}>
            {(props) => (
              <Input
                {...props}
                list={listId}
                disabled={disabled}
                placeholder="Default"
                value={form.effort[role]}
                onChange={(e) => {
                  const value = e.target.value;
                  setForm((f) => ({ ...f, effort: { ...f.effort, [role]: value } }));
                }}
              />
            )}
          </Field>
        ))}
      </div>
    </Section>
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
  const update = (index: number, patch: Partial<ProductForm["riskCaps"][number]>) =>
    onChange(value.map((cap, i) => (i === index ? { ...cap, ...patch } : cap)));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="t-label mb-1.5">Risk caps</legend>
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
            className="w-24"
            disabled={disabled}
            value={cap.level}
            onChange={(e) => update(index, { level: e.target.value as AutonomyLevel })}
          >
            {AUTONOMY_LEVELS.map((level) => (
              <option key={level}>{level}</option>
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
    </fieldset>
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
          <Field label="Default autonomy" className="w-36">
            {(props) => (
              <Select {...props} value={level} onChange={(e) => setLevel(e.target.value as AutonomyLevel)}>
                {AUTONOMY_LEVELS.map((l) => (
                  <option key={l}>{l}</option>
                ))}
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
