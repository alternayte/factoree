import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listApiKeysOptions, listApiKeysQueryKey } from "@/api/@tanstack/react-query.gen";
import { createApiKey, revokeApiKey } from "@/api/sdk.gen";
import type { CreateApiKeyResponse, ListApiKeysResponse } from "@/api/types.gen";
import { Button } from "@/components/button";
import { Confirm } from "@/components/confirm";
import { CopyValue } from "@/components/copy";
import { Field, Input } from "@/components/form";
import { Alert, Empty, ErrorAlert, PageHeader, Section, SkeletonTable, Stack, TableCard } from "@/components/layout";
import { ApiError } from "@/lib/api";
import { useMe } from "@/lib/session";
import { formatDate } from "@/lib/utils";

type ApiKey = ListApiKeysResponse[number];

export function ApiKeysPage() {
  const me = useMe();
  const keys = useQuery(listApiKeysOptions());
  const [created, setCreated] = useState<CreateApiKeyResponse | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: async (id: string) => revokeApiKey({ path: { id }, throwOnError: true }),
    onSuccess: () => {
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: listApiKeysQueryKey() });
    },
  });
  const workspaceId = me.data?.memberships[0]?.linearWorkspaceId ?? "<linearWorkspaceId>";

  return (
    <>
      <PageHeader
        title="API keys"
        description="Keys for scripts. A key acts as you on the admin API. Revoke a key when its script no longer needs it."
      />
      <Stack>
        <CreateKey onCreated={setCreated} />
        {created ? (
          <Section title={`Key “${created.name ?? created.id}” created`} className="enter max-w-[640px]">
            <Alert tone="warning" className="mb-4">
              Copy the key now. Factoree shows it only once.
            </Alert>
            <p className="t-label mb-1.5">API key</p>
            <CopyValue value={created.key} label="API key" />
            <p className="t-label mt-4 mb-1.5">Example</p>
            <CopyValue
              value={`curl -H "Authorization: Bearer ${created.key}" "${window.location.origin}/admin/products?linearWorkspaceId=${workspaceId}"`}
              label="curl example"
            />
            <Button size="sm" variant="ghost" className="mt-3" onClick={() => setCreated(null)}>
              Done
            </Button>
          </Section>
        ) : null}
        <section className="min-w-0">
          <h2 className="t-section mb-3">Your keys</h2>
          <div className="flex flex-col gap-3">
            <ErrorAlert error={keys.error} title="The keys did not load" />
            <ErrorAlert error={revoke.error} />
            {keys.isPending ? <SkeletonTable columns={6} rows={2} label="Loading the keys" /> : null}
            {keys.data?.length === 0 ? (
              <div className="card">
                <Empty>No API keys.</Empty>
              </div>
            ) : null}
            {keys.data && keys.data.length > 0 ? (
              <TableCard>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Starts with</th>
                      <th scope="col">Created</th>
                      <th scope="col">Expires</th>
                      <th scope="col">Last used</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="stagger">
                    {keys.data.map((key) => (
                      <tr key={key.id}>
                        <td className="whitespace-nowrap text-ink">{key.name ?? "—"}</td>
                        <td className="t-value whitespace-nowrap">{key.start ? `${key.start}…` : "—"}</td>
                        <td className="whitespace-nowrap">{formatDate(key.createdAt)}</td>
                        <td className="whitespace-nowrap">{key.expiresAt ? formatDate(key.expiresAt) : "Never"}</td>
                        <td className="whitespace-nowrap">{key.lastRequest ? formatDate(key.lastRequest) : "Never"}</td>
                        <td className="py-1.5 text-right align-middle">
                          <Button size="sm" variant="danger" onClick={() => setRevoking(key)}>
                            Revoke
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableCard>
            ) : null}
          </div>
        </section>
      </Stack>
      <Confirm
        open={revoking !== null}
        title={`Revoke “${revoking?.name ?? revoking?.id ?? ""}”?`}
        confirmLabel="Revoke key"
        mutation={revoke}
        onCancel={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      >
        A script that uses this key gets 401 from now on.
      </Confirm>
    </>
  );
}

function CreateKey({ onCreated }: { onCreated: (key: CreateApiKeyResponse) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [days, setDays] = useState("");
  const create = useMutation({
    mutationFn: async () => {
      const expiresInDays = days.trim() ? Number(days) : undefined;
      return (
        await createApiKey({
          body: { name: name.trim(), ...(expiresInDays ? { expiresInDays } : {}) },
          throwOnError: true,
        })
      ).data;
    },
    onSuccess: (key) => {
      onCreated(key);
      setName("");
      setDays("");
      void qc.invalidateQueries({ queryKey: listApiKeysQueryKey() });
    },
  });
  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors : {};
  return (
    <Section title="Create a key" className="max-w-[640px]">
      <form
        className="flex flex-wrap items-start gap-x-4 gap-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Name" className="w-full sm:w-56" errors={fieldErrors.name}>
          {(props) => (
            <Input
              {...props}
              required
              maxLength={32}
              placeholder="deploy script"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Expires in days (optional)"
          className="w-full sm:w-52"
          hint="1 to 365. Empty never expires."
          errors={fieldErrors.expiresInDays}
        >
          {(props) => (
            <Input
              {...props}
              type="number"
              min={1}
              max={365}
              step={1}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" className="sm:mt-[26px]" disabled={!name.trim()} mutation={create}>
          Create key
        </Button>
      </form>
      <ErrorAlert error={create.error} className="mt-3" />
    </Section>
  );
}
