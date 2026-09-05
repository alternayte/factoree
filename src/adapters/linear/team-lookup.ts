import { LinearClient } from "@linear/sdk";

/**
 * Resolves a Linear team by its key or by its id. The discovery service uses this to bind a
 * repository declaration to a stable team id, so a later key rename in Linear does not break
 * the binding.
 */
export interface LinearTeamLookup {
  resolveTeamKey(tenantId: string, teamKey: string): Promise<{ id: string; key: string } | null>;
  resolveTeamId(tenantId: string, teamId: string): Promise<{ id: string; key: string } | null>;
}

/** The Linear SDK team shape this adapter reads, narrowed to the fields it uses. */
interface LinearTeamSummary {
  id: string;
  key: string;
}

export interface LinearTeamsApi {
  teams(variables: { filter: { key: { eq: string } } }): Promise<{ nodes: LinearTeamSummary[] }>;
  team(id: string): Promise<LinearTeamSummary | null>;
}

/**
 * Reads a Linear team by key or by id. The `tenantId` parameter selects nothing here, because
 * one instance holds one token, the way `LinearAgentClient` does. A later task can route the
 * token by tenant without a change to this interface.
 */
export class LinearTeamLookupClient implements LinearTeamLookup {
  constructor(private readonly client: LinearTeamsApi) {}

  async resolveTeamKey(_tenantId: string, teamKey: string): Promise<{ id: string; key: string } | null> {
    const result = await this.client.teams({ filter: { key: { eq: teamKey } } });
    const team = result.nodes[0];
    if (team === undefined) return null;
    return { id: team.id, key: team.key };
  }

  async resolveTeamId(_tenantId: string, teamId: string): Promise<{ id: string; key: string } | null> {
    const team = await this.client.team(teamId);
    if (team === null) return null;
    return { id: team.id, key: team.key };
  }
}

export const createLinearTeamLookup = (accessToken: string): LinearTeamLookupClient =>
  new LinearTeamLookupClient(new LinearClient({ accessToken }));
