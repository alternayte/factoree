import type { ListSetupDerivedHostsResponse } from "@/api/types.gen";
import { Button } from "@/components/button";

export type DerivedHost = ListSetupDerivedHostsResponse["hosts"][number];

/** What the host credential form opens with: a host, and for github.com the repository to add. */
export interface CredentialPrefill {
  host: string;
  repository?: string;
}

/** The hosts the product allow list takes: every derived host except a github.com repository. */
export const allowListHostsOf = (hosts: readonly DerivedHost[]): string[] => [
  ...new Set(hosts.filter((entry) => entry.host !== "github.com").map((entry) => entry.host)),
];

/**
 * docs/specs/private-stack-onboarding.md. The derived hosts that no allow list or host credential
 * covers: the hosts the repository's committed files name. The operator adds them all at once, or
 * adds a host credential for a private feed. A github.com repository goes to the GitHub
 * credential.
 */
export function DerivedHostsPanel({
  hosts,
  canEdit,
  onAddAll,
  addingAll,
  onAddCredential,
  footer,
}: {
  hosts: readonly DerivedHost[];
  canEdit: boolean;
  onAddAll: (hosts: string[]) => void;
  addingAll: boolean;
  onAddCredential: (prefill: CredentialPrefill) => void;
  footer?: React.ReactNode;
}) {
  const allowList = allowListHostsOf(hosts);
  return (
    <div className="my-2 rounded-md border border-hairline p-3">
      <p className="text-body">
        The repository&apos;s committed files name these hosts, and no allow list or host credential covers them.
        Sandboxes reach public-internet hosts only.
      </p>
      <ul className="my-2 space-y-1">
        {hosts.map((entry) => (
          <li key={`${entry.kind}:${entry.host}:${entry.repository ?? ""}`} className="flex flex-wrap items-center gap-2">
            <code className="break-all">{entry.repository === undefined ? entry.host : `${entry.host}/${entry.repository}`}</code>
            <span className="text-xs text-mute">from {entry.source}</span>
            {canEdit ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onAddCredential({ host: entry.host, ...(entry.repository === undefined ? {} : { repository: entry.repository }) })}
              >
                {entry.host === "github.com" ? "Add to GitHub credential" : "Add host credential"}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {canEdit && allowList.length > 0 ? (
          <Button variant="secondary" onClick={() => onAddAll(allowList)} pending={addingAll}>
            Add all {allowList.length} to product allow list
          </Button>
        ) : null}
        {footer}
      </div>
    </div>
  );
}
