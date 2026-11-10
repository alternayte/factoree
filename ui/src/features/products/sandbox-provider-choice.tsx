import { useQuery } from "@tanstack/react-query";
import { listSandboxProvidersOptions } from "@/api/@tanstack/react-query.gen";
import { Button } from "@/components/button";
import { Switch } from "@/components/form";
import { Badge, ErrorAlert, SkeletonRows } from "@/components/layout";

/**
 * docs/specs/sandbox-provider-spillover.md. The sandbox providers a product's runs may use. An empty
 * choice allows every provider, so a new provider serves the product at once.
 */
export function SandboxProviderChoice({
  value,
  disabled,
  onChange,
}: {
  value: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const providers = useQuery(listSandboxProvidersOptions());
  if (providers.isPending) return <SkeletonRows rows={2} label="Loading the sandbox providers" />;
  if (providers.error) return <ErrorAlert error={providers.error} title="The sandbox providers did not load" />;
  const list = providers.data ?? [];
  const known = new Set(list.map((provider) => provider.id));
  const missing = value.filter((id) => !known.has(id));
  return (
    <div className="flex flex-col gap-2.5">
      {value.length === 0 ? (
        <span className="self-start">
          <Badge tone="accent">Every provider</Badge>
        </span>
      ) : null}
      {list.map((provider) => (
        <Switch
          key={provider.id}
          checked={value.includes(provider.id)}
          disabled={disabled}
          label={`${provider.name} (priority ${provider.priority}${provider.enabled ? "" : ", disabled"})`}
          onCheckedChange={(checked) => {
            const kept = value.filter((id) => known.has(id) && id !== provider.id);
            onChange(checked ? [...kept, provider.id].sort() : kept);
          }}
        />
      ))}
      {missing.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="t-hint text-danger">The install no longer lists {missing.join(", ")}.</p>
          <Button variant="ghost" disabled={disabled} onClick={() => onChange(value.filter((id) => known.has(id)))}>
            Drop it from the choice
          </Button>
        </div>
      ) : null}
    </div>
  );
}
