/**
 * docs/specs/kiln-sandbox-provider.md. The warm snapshot of one repository: the sandbox right after
 * the clone and the bootstrap, before any agent runs. It is valid for one Kiln template and one
 * `.factoree/config.yaml` blob. A change of either makes a new snapshot on the next run.
 */
export interface WarmSnapshot {
  tenantId: string;
  /** The adapter that holds the snapshot. A snapshot id means nothing to another adapter. */
  adapter: string;
  repositoryUrl: string;
  /** docs/specs/kiln-sandbox-size.md. The template the snapshot holds: the image digest and the size. */
  template: string;
  /** The git blob SHA of `.factoree/config.yaml` at the commit the snapshot holds. */
  configSha: string;
  snapshotId: string;
}

/**
 * A snapshot that no row names any more and that the provider still holds: one that a new
 * snapshot replaced, or one that did not restore. The reaper removes it.
 */
export interface RetiredWarmSnapshot {
  /** The tenant whose checkout the snapshot holds. */
  tenantId: string;
  adapter: string;
  snapshotId: string;
}

/** One warm snapshot per tenant, adapter and repository. A new one replaces the old one. */
export interface WarmSnapshotStore {
  find(key: { tenantId: string; adapter: string; repositoryUrl: string }): Promise<WarmSnapshot | null>;
  /** Stores the snapshot, and returns the snapshot it replaced, so the caller can remove it. */
  save(snapshot: WarmSnapshot): Promise<WarmSnapshot | null>;
  /** Forgets the snapshot, only while it is still the stored one. */
  forget(snapshot: WarmSnapshot): Promise<void>;
  /** Records a snapshot to remove later. A second record of the same snapshot changes nothing. */
  retire(snapshot: RetiredWarmSnapshot): Promise<void>;
  listRetired(limit: number): Promise<RetiredWarmSnapshot[]>;
  /** Drops the record once the provider removed the snapshot. */
  dropRetired(snapshot: RetiredWarmSnapshot): Promise<void>;
}
