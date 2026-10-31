import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { listLinearTeamsOptions, listProductsOptions, listProductsQueryKey } from "@/api/@tanstack/react-query.gen";
import { createProduct } from "@/api/sdk.gen";
import { Button } from "@/components/button";
import { Field, FieldGrid, Input, Select } from "@/components/form";
import { Alert, Badge, Empty, ErrorAlert, PageHeader, Section, SkeletonTable, TableCard } from "@/components/layout";
import { ApiError } from "@/lib/api";
import { useMe, type Membership } from "@/lib/session";
import { pickWorkspace } from "@/lib/workspace";
import { WorkspacePicker } from "./workspace-picker";

export function ProductsPage({ ws }: { ws?: string }) {
  const me = useMe();
  const memberships = me.data?.memberships ?? [];
  const workspace = pickWorkspace(memberships, ws);
  const [creating, setCreating] = useState(false);

  if (!workspace) {
    return (
      <>
        <PageHeader title="Products" />
        <Alert tone="info">You are a member of no workspace where Factoree is installed.</Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Products"
        description="A product maps one Linear team to Factoree, with its model, policy, secrets and limits."
        actions={
          workspace.admin && !creating ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              New product
            </Button>
          ) : null
        }
      />
      <div className="mb-5">
        <WorkspacePicker memberships={memberships} current={workspace} />
      </div>
      {!workspace.admin ? (
        <Alert tone="info" className="mb-4 max-w-[640px]">
          You are a member of this workspace. A Linear workspace admin changes its products.
        </Alert>
      ) : null}
      {creating ? <CreateProduct workspace={workspace} onClose={() => setCreating(false)} /> : null}
      <ProductList workspace={workspace} />
    </>
  );
}

function ProductList({ workspace }: { workspace: Membership }) {
  const products = useQuery(listProductsOptions({ query: { linearWorkspaceId: workspace.linearWorkspaceId } }));
  if (products.isPending) return <SkeletonTable columns={6} label="Loading the products" />;
  if (products.isError) return <ErrorAlert error={products.error} title="The products did not load" />;
  if (products.data.length === 0) {
    return (
      <div className="card">
        <Empty>No products in {workspace.workspaceName}.</Empty>
      </div>
    );
  }
  return (
    <TableCard>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">Linear team</th>
            <th scope="col">Status</th>
            <th scope="col">Autonomy</th>
            <th scope="col">Model</th>
            <th scope="col" className="text-right">
              Parallel runs
            </th>
          </tr>
        </thead>
        <tbody className="stagger">
          {products.data.map((p) => (
            <tr key={p.id}>
              <td className="whitespace-nowrap">
                <Link
                  to="/products/$productId"
                  params={{ productId: p.id }}
                  search={{ ws: workspace.linearWorkspaceId }}
                  className="link font-medium no-underline hover:underline"
                >
                  {p.name}
                </Link>
                <div className="font-mono text-xs text-mute">{p.slug}</div>
              </td>
              <td className="t-value">{p.linearTeamKey}</td>
              <td>
                {p.status === "active" ? <Badge tone="success">active</Badge> : <Badge tone="warning">pending</Badge>}
              </td>
              <td className="t-value">{p.defaultAutonomy}</td>
              <td className="t-value">{p.model ?? <span className="font-sans text-mute">Default</span>}</td>
              <td className="t-value text-right">{p.maxConcurrentRuns}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableCard>
  );
}

function CreateProduct({ workspace, onClose }: { workspace: Membership; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const teams = useQuery(listLinearTeamsOptions({ query: { linearWorkspaceId: workspace.linearWorkspaceId } }));
  const [teamKey, setTeamKey] = useState("");
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [skills, setSkills] = useState("");
  const [maxRunMinutes, setMaxRunMinutes] = useState("");

  const create = useMutation({
    mutationFn: async () =>
      (
        await createProduct({
          body: {
            linearWorkspaceId: workspace.linearWorkspaceId,
            workspaceName: workspace.workspaceName,
            linearTeamKey: teamKey,
            slug: slug.trim(),
            name: name.trim(),
            ...(skills.trim() ? { organizationSkillsRepository: skills.trim() } : {}),
            ...(maxRunMinutes.trim() ? { maxRunMinutes: Number(maxRunMinutes) } : {}),
          },
          throwOnError: true,
        })
      ).data,
    onSuccess: (product) => {
      void qc.invalidateQueries({
        queryKey: listProductsQueryKey({ query: { linearWorkspaceId: workspace.linearWorkspaceId } }),
      });
      void navigate({
        to: "/products/$productId",
        params: { productId: product.id },
        search: { ws: workspace.linearWorkspaceId },
      });
    },
  });

  function chooseTeam(key: string) {
    const team = teams.data?.find((t) => t.key === key);
    setTeamKey(key);
    if (team && !slug) setSlug(team.key.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
    if (team && !name) setName(team.name);
  }

  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors : {};

  return (
    <Section
      title="New product"
      description="A new product starts pending. Activate it on its page with a default autonomy level."
      className="enter mb-4 max-w-[640px]"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <ErrorAlert error={teams.error} title="The Linear teams did not load" />
        <FieldGrid>
          <Field label="Linear team" errors={fieldErrors.linearTeamKey}>
            {(props) => (
              <Select
                {...props}
                required
                value={teamKey}
                disabled={teams.isPending}
                onChange={(e) => chooseTeam(e.target.value)}
              >
                <option value="">{teams.isPending ? "Loading teams…" : "Choose a team"}</option>
                {teams.data?.map((team) => (
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
          <Field
            label="Organization skills repository (optional)"
            hint="owner/repository"
            errors={fieldErrors.organizationSkillsRepository}
          >
            {(props) => (
              <Input
                {...props}
                mono
                pattern="[^/]+/[^/]+"
                placeholder="acme/skills"
                value={skills}
                onChange={(e) => setSkills(e.target.value)}
              />
            )}
          </Field>
          <Field label="Run time limit, minutes (optional)" hint="1 to 600." errors={fieldErrors.maxRunMinutes}>
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={600}
                step={1}
                value={maxRunMinutes}
                onChange={(e) => setMaxRunMinutes(e.target.value)}
              />
            )}
          </Field>
        </FieldGrid>
        <ErrorAlert error={create.error} />
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button type="submit" variant="primary" disabled={!teamKey} mutation={create}>
            Create product
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Section>
  );
}
