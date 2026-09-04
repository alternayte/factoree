export interface ProductRecord {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  status: "pending" | "active";
  linearTeamKey: string;
  linearTeamId: string;
  defaultAutonomy: string;
  maxRunMinutes: number;
  /** Specification section 16. The organization-wide skills repository slug, or null. */
  organizationSkillsRepository: string | null;
  createdAt: Date;
  updatedAt: Date;
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
}
