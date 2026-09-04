import type { LinearTeamLookup } from "./team-lookup.js";
import { createLinearTeamLookup } from "./team-lookup.js";
import type { LinearTokenProvider } from "~/domain/products/linear-token-provider.js";

/**
 * Reads the Linear workspace id of a tenant. The Products administration route holds a tenant
 * id, not a workspace id, so this is the one seam a caller supplies.
 */
export interface TenantWorkspaceLookup {
  linearWorkspaceIdFor(tenantId: string): Promise<string | null>;
}

/**
 * Resolves a Linear team by tenant. `LinearTeamLookupClient` holds one access token per
 * instance. A tenant id carries no workspace id of its own. This adapter reads the workspace id
 * of the tenant. It asks `LinearTokenProvider` for that workspace token. It then builds a fresh
 * client with the token. Neither the workspace id nor the token ever reaches a thrown message or
 * a log line here. `LinearTokenProvider` already keeps a token out of its own error text. This
 * adapter passes every error of that provider through unchanged.
 *
 * A tenant that does not resolve answers null from both methods. This matches the shape of a
 * team that does not resolve. The Products routes look up the tenant before they call this
 * adapter. A caller only reaches this path when the tenant already exists at that point.
 */
export class TenantScopedLinearTeamLookup implements LinearTeamLookup {
  constructor(
    private readonly tenants: TenantWorkspaceLookup,
    private readonly tokens: LinearTokenProvider,
    // A test substitutes this, so no unit test call reaches the real Linear API.
    private readonly buildClient: (accessToken: string) => LinearTeamLookup = createLinearTeamLookup,
  ) {}

  async resolveTeamKey(tenantId: string, teamKey: string): Promise<{ id: string; key: string } | null> {
    const client = await this.clientFor(tenantId);
    if (client === null) return null;
    return client.resolveTeamKey(tenantId, teamKey);
  }

  async resolveTeamId(tenantId: string, teamId: string): Promise<{ id: string; key: string } | null> {
    const client = await this.clientFor(tenantId);
    if (client === null) return null;
    return client.resolveTeamId(tenantId, teamId);
  }

  private async clientFor(tenantId: string): Promise<LinearTeamLookup | null> {
    const linearWorkspaceId = await this.tenants.linearWorkspaceIdFor(tenantId);
    if (linearWorkspaceId === null) return null;
    const token = await this.tokens.tokenFor(linearWorkspaceId);
    return this.buildClient(token);
  }
}
