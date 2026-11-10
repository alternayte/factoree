import type { SkillRegistrySettings } from "~/domain/runs/skill-registry.js";
import type { AppChangeIssueMode } from "~/domain/setup/app-change-issues.js";
import type { AgentRunnerName, RoleValues } from "~/domain/products/agent-settings.js";

export interface ProductRecord {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  status: "pending" | "active";
  linearTeamKey: string;
  linearTeamId: string;
  defaultAutonomy: string;
  /** docs/specs/autonomy-levels.md. The highest level each label allows. Null means the SDD defaults. */
  riskCaps: Record<string, string> | null;
  /** R-4. The egress ceiling of every sandbox of this Product. */
  allowedDomains: string[];
  maxRunMinutes: number;
  /** Specification section 16. The organization-wide skills repository slug, or null. */
  organizationSkillsRepository: string | null;
  /** docs/specs/skill-registry.md. The skill registry of the Product, or null. */
  skillRegistry: SkillRegistrySettings | null;
  /** docs/specs/claude-code-runner.md. The runner of every role that names none. */
  defaultRunner: AgentRunnerName;
  /** The default model, in the form of the default runner, or null for the CLI default. */
  model: string | null;
  /** docs/specs/claude-code-runner.md. The runner of each role, or null for the default runner. */
  runners: RoleValues<AgentRunnerName>;
  /** docs/specs/claude-code-runner.md. The model of each role, or null for the default model. */
  models: RoleValues<string>;
  /** The reasoning effort of each role, or null for the CLI default. */
  effort: ProductEffort;
  /** The silence limit of an agent session, in minutes. */
  silenceMinutes: number;
  /** SDD section 51. The hours a finished sandbox stays before the reaper deletes it. */
  sandboxRetentionHours: number;
  /** docs/specs/sandbox-provider-spillover.md. The sandbox providers its runs may use. Empty allows all. */
  sandboxProviderIds: string[];
  /** The most Runs of this Product at one time. The gate before PREPARING enforces it (DI-15.13). */
  maxConcurrentRuns: number;
  /** docs/specs/setup-app-change-issues.md. How many app-change issues a merged setup creates. */
  appChangeIssues: AppChangeIssueMode;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductEffort {
  implementer: string | null;
  refiner: string | null;
  validator: string | null;
  reviewer: string | null;
  /** docs/specs/repository-setup-and-services.md. Null means the implementer's effort. */
  setup: string | null;
}

/** docs/specs/release-0-1-0.md. The Product settings an operator changes in the UI. */
export interface ProductSettingsUpdate {
  defaultRunner?: AgentRunnerName;
  model?: string | null;
  /** An absent role keeps its runner, and null clears it. */
  runners?: { [Role in keyof ProductEffort]?: AgentRunnerName | null | undefined };
  /** An absent role keeps its model, and null clears it. */
  models?: { [Role in keyof ProductEffort]?: string | null | undefined };
  /** An absent role keeps its effort, and null clears it. */
  effort?: { [Role in keyof ProductEffort]?: string | null | undefined };
  silenceMinutes?: number;
  sandboxRetentionHours?: number;
  sandboxProviderIds?: string[];
  maxConcurrentRuns?: number;
  appChangeIssues?: AppChangeIssueMode;
}

export interface CreateProductInput {
  tenantId: string;
  slug: string;
  name: string;
  linearTeamKey: string;
  linearTeamId: string;
  maxRunMinutes?: number;
  organizationSkillsRepository?: string | null;
}

/**
 * A Product owns policy. It reads by tenant and slug, or by tenant and Linear team id, never by
 * a bare column, so a lookup never picks the wrong tenant row by accident.
 */
export interface ProductRegistry {
  create(input: CreateProductInput): Promise<ProductRecord>;
  list(tenantId: string): Promise<ProductRecord[]>;
  findById(tenantId: string, id: string): Promise<ProductRecord | null>;
  findBySlug(tenantId: string, slug: string): Promise<ProductRecord | null>;
  /**
   * The column pair carries a unique constraint, so this reads one row or none. There is no
   * fallback to a tenant default, because a guess would route a webhook to the wrong Product.
   */
  findByLinearTeamId(tenantId: string, linearTeamId: string): Promise<ProductRecord | null>;
  activate(tenantId: string, id: string, defaultAutonomy: string): Promise<ProductRecord | null>;
  /**
   * A Linear team id is stable across a team key rename, so the binding survives and only the
   * stored key changes. A later discovery task calls this when Linear reports a new key.
   */
  renameLinearTeamKey(tenantId: string, id: string, linearTeamKey: string): Promise<ProductRecord | null>;
  /**
   * Changes the organization-wide skills repository slug, or clears it with null. The
   * administration API exposes this on create and on update, per specification section 16.
   */
  updateOrganizationSkillsRepository(
    tenantId: string,
    id: string,
    organizationSkillsRepository: string | null,
  ): Promise<ProductRecord | null>;
  /** docs/specs/skill-registry.md. Sets the skill registry of the Product, or clears it with null. */
  updateSkillRegistry(tenantId: string, id: string, skillRegistry: SkillRegistrySettings | null): Promise<ProductRecord | null>;
  /**
   * F8. The replaced `PUT /admin/projects/:id` route let an operator change the name and the
   * maximum Run minutes. `PUT /admin/products/:id` must allow the same, because discovery owns
   * mechanics but a human still owns these policy fields.
   */
  update(
    tenantId: string,
    id: string,
    fields: { name?: string; maxRunMinutes?: number },
  ): Promise<ProductRecord | null>;
  /**
   * F6. Discovery auto-creates a pending Product for any repository that names an unknown
   * slug, so an operator needs a way to remove one a typo handed them. Returns false when no row
   * of that tenant and id exists.
   */
  remove(tenantId: string, id: string): Promise<boolean>;
  /**
   * docs/specs/autonomy-levels.md. Changes the default level and the risk caps, and writes one
   * policy history row for each field whose value changed, in one transaction.
   */
  updatePolicy(tenantId: string, id: string, policy: ProductPolicyUpdate): Promise<ProductRecord | null>;
  /** docs/specs/release-0-1-0.md. Changes the model, the effort, the silence limit, retention and concurrency. */
  updateSettings(tenantId: string, id: string, settings: ProductSettingsUpdate): Promise<ProductRecord | null>;
}

export interface ProductPolicyUpdate {
  defaultAutonomy?: string;
  riskCaps?: Record<string, string>;
  allowedDomains?: string[];
}
