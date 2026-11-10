import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { listProductSecretsOptions, listProductSecretsQueryKey } from "@/api/@tanstack/react-query.gen";
import { deleteProductSecret, putProductSecret } from "@/api/sdk.gen";
import type { ListProductSecretsResponse, PutProductSecretData } from "@/api/types.gen";
import { Button } from "@/components/button";
import { Confirm } from "@/components/confirm";
import { Field, Input, Select, Switch } from "@/components/form";
import { Badge, Empty, ErrorAlert, Section, SkeletonRows } from "@/components/layout";
import { ApiError } from "@/lib/api";

type Secret = ListProductSecretsResponse[number];
type Kind = NonNullable<PutProductSecretData["body"]["kind"]>;

// SDD §30. repository_read and publish are retired: the GitHub App replaced them. An existing
// secret keeps its kind on screen, but a new or replaced secret takes one of the two live kinds.
const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: "test", label: "Test", hint: "A non-production test secret. The implementer gets it only when marked." },
  {
    value: "runner_credential",
    label: "Runner credential",
    hint: "A model provider key. It reaches the sandbox environment, never a prompt.",
  },
];

const RETIRED: Record<string, string> = { repository_read: "Repository read (retired)", publish: "Publish (retired)" };

const kindLabel = (kind: string) => KINDS.find((k) => k.value === kind)?.label ?? RETIRED[kind] ?? kind;

/** docs/specs/model-picker.md. A request from the model picker to add one provider key. */
export type KeyRequest = { name: string; nonce: number };

export function SecretsSection({
  productId,
  linearWorkspaceId,
  canEdit,
  keyRequest,
}: {
  productId: string;
  linearWorkspaceId: string;
  canEdit: boolean;
  keyRequest?: KeyRequest | null;
}) {
  const qc = useQueryClient();
  const options = { path: { id: productId }, query: { linearWorkspaceId } };
  const secrets = useQuery(listProductSecretsOptions(options));
  const [editing, setEditing] = useState<Secret | "new" | KeyRequest | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  // Add key in the model picker opens this form with the provider key name and the runner kind.
  useEffect(() => {
    if (!keyRequest || !canEdit) return;
    setEditing(keyRequest);
    anchor.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [keyRequest, canEdit]);
  const [deleting, setDeleting] = useState<Secret | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: listProductSecretsQueryKey(options) });

  const remove = useMutation({
    mutationFn: async (name: string) =>
      deleteProductSecret({ path: { id: productId, name }, query: { linearWorkspaceId }, throwOnError: true }),
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });

  return (
    <Section
      title="Secrets"
      description="Values are write-only. Factoree stores them encrypted and never shows them again."
      actions={
        canEdit && editing === null ? (
          <Button size="sm" onClick={() => setEditing("new")}>
            Add secret
          </Button>
        ) : null
      }
    >
      <div ref={anchor} />
      {editing !== null ? (
        <SecretForm
          key={editing === "new" ? "new" : "nonce" in editing ? editing.nonce : editing.name}
          productId={productId}
          linearWorkspaceId={linearWorkspaceId}
          existing={editing === "new" || "nonce" in editing ? null : editing}
          preset={editing !== "new" && "nonce" in editing ? editing.name : null}
          onDone={() => {
            setEditing(null);
            void refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {secrets.isPending ? <SkeletonRows label="Loading the secrets" /> : null}
      <ErrorAlert error={secrets.error} title="The secrets did not load" />
      <ErrorAlert error={remove.error} />
      {secrets.data?.length === 0 ? <Empty>No secrets.</Empty> : null}
      {secrets.data && secrets.data.length > 0 ? (
        <ul className="stagger -my-2 divide-y divide-hairline">
          {secrets.data.map((secret) => (
            <li key={secret.name} className="flex flex-wrap items-center gap-2 py-2.5">
              <span className="t-value min-w-0 flex-1 break-all text-ink">{secret.name}</span>
              <Badge>{kindLabel(secret.kind)}</Badge>
              {secret.injectIntoImplementer ? <Badge>in implementer</Badge> : null}
              <Badge tone="success">stored</Badge>
              {canEdit ? (
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(secret)}>
                    Replace
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setDeleting(secret)}>
                    Delete
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <Confirm
        open={deleting !== null}
        title={`Delete the secret ${deleting?.name ?? ""}?`}
        confirmLabel="Delete secret"
        mutation={remove}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.name)}
      >
        Runs that start after this no longer get the secret.
      </Confirm>
    </Section>
  );
}

function SecretForm({
  productId,
  linearWorkspaceId,
  existing,
  preset,
  onDone,
  onCancel,
}: {
  productId: string;
  linearWorkspaceId: string;
  existing: Secret | null;
  /** A provider key name from the model picker. The form then adds a runner credential. */
  preset?: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? preset ?? "");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<Kind>(existing?.kind === "runner_credential" || preset ? "runner_credential" : "test");
  const [inject, setInject] = useState(existing?.injectIntoImplementer ?? false);

  const put = useMutation({
    mutationFn: async () =>
      putProductSecret({
        path: { id: productId, name: name.trim() },
        query: { linearWorkspaceId },
        // Only a test secret may carry the injection mark.
        body: { value, kind, injectIntoImplementer: kind === "test" && inject },
        throwOnError: true,
      }),
    onSuccess: onDone,
  });
  const fieldErrors = put.error instanceof ApiError ? put.error.fieldErrors : {};

  return (
    <form
      className="enter mb-4 flex flex-col gap-4 rounded-control border border-hairline-strong bg-raised/50 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        put.mutate();
      }}
    >
      <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
        <Field label="Name" hint="For example DEEPSEEK_API_KEY.">
          {(props) => (
            <Input
              {...props}
              required
              mono
              autoComplete="off"
              disabled={existing !== null}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label={existing ? "New value" : "Value"} errors={fieldErrors.value}>
          {(props) => (
            <Input
              {...props}
              mono
              required
              type="password"
              autoComplete="off"
              autoFocus={Boolean(preset)}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </Field>
        <Field label="Kind" hint={KINDS.find((k) => k.value === kind)?.hint} errors={fieldErrors.kind}>
          {(props) => (
            <Select {...props} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Switch
        checked={kind === "test" && inject}
        onCheckedChange={setInject}
        disabled={kind !== "test"}
        label="Give the secret to the implementer (test secrets only)"
      />
      <ErrorAlert error={put.error} />
      <div className="flex flex-wrap items-center gap-3">
        {/* Save product is the primary action of the product page. */}
        <Button type="submit" disabled={!name.trim() || !value} mutation={put}>
          {existing ? "Replace secret" : "Add secret"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
