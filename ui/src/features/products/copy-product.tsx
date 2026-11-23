import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { listLinearTeamsOptions, listProductsOptions, listProductsQueryKey } from "@/api/@tanstack/react-query.gen";
import { copyProduct } from "@/api/sdk.gen";
import { Button } from "@/components/button";
import { Field, FieldGrid, Input, Select } from "@/components/form";
import { ErrorAlert, Section } from "@/components/layout";
import { ApiError } from "@/lib/api";
import type { Product } from "./product-form";

/**
 * docs/specs/product-copy.md. A new pending product with the settings, secrets, host credentials
 * and context sources of this one, on a Linear team that no product holds.
 */
export function CopyProduct({
  source,
  linearWorkspaceId,
  onClose,
}: {
  source: Product;
  linearWorkspaceId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const teams = useQuery(listLinearTeamsOptions({ query: { linearWorkspaceId } }));
  const products = useQuery(listProductsOptions({ query: { linearWorkspaceId } }));
  const held = new Set(products.data?.map((product) => product.linearTeamId));
  const free = teams.data?.filter((team) => !held.has(team.id)) ?? [];
  const loading = teams.isPending || products.isPending;
  const [teamKey, setTeamKey] = useState("");
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");

  const copy = useMutation({
    mutationFn: async () =>
      (
        await copyProduct({
          path: { id: source.id },
          query: { linearWorkspaceId },
          body: { linearTeamKey: teamKey, slug: slug.trim(), name: name.trim() },
          throwOnError: true,
        })
      ).data,
    onSuccess: (product) => {
      void qc.invalidateQueries({ queryKey: listProductsQueryKey({ query: { linearWorkspaceId } }) });
      onClose();
      void navigate({ to: "/products/$productId", params: { productId: product.id }, search: { ws: linearWorkspaceId } });
    },
  });

  function chooseTeam(key: string) {
    const team = free.find((t) => t.key === key);
    setTeamKey(key);
    if (team && !slug) setSlug(team.key.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
    if (team && !name) setName(team.name);
  }

  const fieldErrors = copy.error instanceof ApiError ? copy.error.fieldErrors : {};

  return (
    <Section
      title={`Copy ${source.name}`}
      description="The copy takes every setting, secret, host credential and context source of this product, but no repository. It starts pending. Later changes to one product do not change the other."
      className="enter mb-4 max-w-[640px]"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          copy.mutate();
        }}
      >
        <ErrorAlert error={teams.error ?? products.error} title="The Linear teams did not load" />
        <FieldGrid>
          <Field
            label="Linear team"
            hint={!loading && free.length === 0 ? "Every Linear team already has a product." : "Only teams with no product."}
            errors={fieldErrors.linearTeamKey}
          >
            {(props) => (
              <Select {...props} required value={teamKey} disabled={loading} onChange={(e) => chooseTeam(e.target.value)}>
                <option value="">{loading ? "Loading teams…" : "Choose a team"}</option>
                {free.map((team) => (
                  <option key={team.id} value={team.key}>
                    {team.name} ({team.key})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Slug" errors={fieldErrors.slug}>
            {(props) => <Input {...props} mono required value={slug} onChange={(e) => setSlug(e.target.value)} />}
          </Field>
          <Field label="Name" errors={fieldErrors.name}>
            {(props) => <Input {...props} required value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
        </FieldGrid>
        <ErrorAlert error={copy.error} />
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button type="submit" variant="primary" disabled={!teamKey} mutation={copy}>
            Copy product
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Section>
  );
}
