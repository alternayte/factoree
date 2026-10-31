import type { RepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";
import type { LinearTeamLookup } from "~/adapters/linear/team-lookup.js";
import { FactoreeConfigPrivilegeError, parseFactoreeConfig } from "~/domain/products/factoree-config.js";
import type { ProductRecord, ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import type { Logger } from "~/telemetry/logger.js";

export type DiscoveryOutcome =
  | {
      kind: "registered";
      repositoryId: string;
      productId: string;
      productCreated: boolean;
      // Set when the stored Linear team key no longer matches Linear. The binding survives,
      // because the team id is stable. Specification section 9 requires a warning, not a failure.
      drift?: "linear_team_key_renamed";
    }
  | { kind: "skipped"; reason: string }
  | { kind: "conflict"; reason: string };

/**
 * Turns one repository declaration, read from `.factoree/config.yaml`, into stored rows. A
 * repository declares its own binding. This service decides when a Product is created, when a
 * repository attaches to an existing Product, and when a declaration must be refused.
 */
export class DiscoveryService {
  constructor(
    private readonly discoveryClient: RepositoryDiscoveryClient,
    private readonly products: ProductRegistry,
    private readonly repositories: RepositoryRegistry,
    private readonly linearTeamLookup: LinearTeamLookup,
    private readonly logger: Logger,
  ) {}

  async syncRepository(
    tenantId: string,
    fullName: string,
    defaultBranch: string,
    githubInstallationId: string,
  ): Promise<DiscoveryOutcome> {
    const file = await this.discoveryClient.readConfig(fullName, defaultBranch, githubInstallationId);
    if (file === null) {
      return { kind: "skipped", reason: `${fullName} carries no .factoree/config.yaml at ${defaultBranch}.` };
    }

    let config;
    try {
      config = parseFactoreeConfig(file.content);
    } catch (error) {
      if (error instanceof FactoreeConfigPrivilegeError) {
        return {
          kind: "conflict",
          reason: `${fullName} sets ${error.key} in .factoree/config.yaml. The Product owns it.`,
        };
      }
      throw error;
    }

    const slug = config.identity.product;
    const declaredTeamKey = config.identity.linear.teamKey;
    const team = await this.linearTeamLookup.resolveTeamKey(tenantId, declaredTeamKey);
    if (team === null) {
      return { kind: "conflict", reason: `${fullName} names the Linear team ${declaredTeamKey}, which does not exist.` };
    }

    const bySlug = await this.products.findBySlug(tenantId, slug);
    const byTeam = await this.products.findByLinearTeamId(tenantId, team.id);

    let product: ProductRecord;
    let productCreated = false;
    if (bySlug !== null && bySlug.linearTeamId === team.id) {
      // The slug and the team both point at the same Product. The repository attaches.
      product = bySlug;
    } else if (bySlug === null && byTeam === null) {
      product = await this.products.create({
        tenantId,
        slug,
        name: slug,
        linearTeamKey: team.key,
        linearTeamId: team.id,
      });
      productCreated = true;
    } else {
      // Another Product already claims this team, or this slug already claims a different team.
      // A row here lets two Products answer one team webhook. The routing rule of
      // specification section 9 forbids that, so this method refuses the declaration.
      const claimant = byTeam?.slug ?? bySlug?.slug ?? slug;
      return {
        kind: "conflict",
        reason: `${fullName} claims the team ${team.key} for "${slug}", but Product "${claimant}" already claims it.`,
      };
    }

    let drift: "linear_team_key_renamed" | undefined;
    if (product.linearTeamKey !== team.key) {
      const renamed = await this.products.renameLinearTeamKey(tenantId, product.id, team.key);
      if (renamed !== null) product = renamed;
      this.logger.warn("Linear renamed a Product team key. The binding survives.", {
        product_id: product.id,
        previous_team_key: config.identity.linear.teamKey,
        current_team_key: team.key,
      });
      drift = "linear_team_key_renamed";
    }

    const repository = await this.repositories.upsert({
      tenantId,
      productId: product.id,
      fullName,
      defaultBranch,
      configSha: file.sha,
      requestedSecretNames: config.secrets.require,
      linearProjects: config.identity.linear.projects,
      githubInstallationId,
    });

    return {
      kind: "registered",
      repositoryId: repository.id,
      productId: product.id,
      productCreated,
      ...(drift !== undefined ? { drift } : {}),
    };
  }

  async markAbsent(tenantId: string, fullName: string): Promise<void> {
    await this.repositories.markAbsent(tenantId, fullName, new Date());
  }
}
