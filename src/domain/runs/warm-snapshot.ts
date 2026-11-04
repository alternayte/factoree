import { createHash } from "node:crypto";

/**
 * docs/specs/kiln-sandbox-provider.md. The warm snapshot of one repository: the sandbox right after
 * the clone, the bootstrap and the warm command, before any agent runs. It is valid for one Kiln
 * template and one bootstrap key. A change of either makes a new snapshot (docs/specs/run-speed.md).
 */
export interface WarmSnapshot {
  tenantId: string;
  /** The adapter that holds the snapshot. A snapshot id means nothing to another adapter. */
  adapter: string;
  repositoryUrl: string;
  /** docs/specs/kiln-sandbox-size.md. The template the snapshot holds: the image digest and the size. */
  template: string;
  /** docs/specs/run-speed.md. The bootstrap key of the configuration the snapshot ran. */
  bootstrapKey: string;
  /** The exit code of a failed warm command, or null when it passed or none ran. */
  warmCommandExitCode: number | null;
  snapshotId: string;
}

/** The inputs that decide what a warm snapshot holds. */
export interface BootstrapInputs {
  bootstrapCommand: string | null;
  warmCommand: string | null;
  /** The effective allow list of the repository: the Product list narrowed by the repository. */
  allowedDomains: readonly string[];
}

/**
 * docs/specs/run-speed.md. The SHA-256 of the bootstrap command, the warm command and the
 * effective bootstrap allow list. Only these change what a warm snapshot holds, so a change to
 * `verify`, `agents`, `preview` or `identity` keeps the snapshot.
 */
export const bootstrapKeyOf = (inputs: BootstrapInputs): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        bootstrap: inputs.bootstrapCommand,
        warm: inputs.warmCommand,
        allowedDomains: [...new Set(inputs.allowedDomains)].sort(),
      }),
    )
    .digest("hex");

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
