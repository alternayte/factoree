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
}
