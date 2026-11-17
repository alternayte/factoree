import { createHash } from "node:crypto";
import path from "node:path";
import type { ProjectRuntimeConfig, ServicesConfig } from "./project-runtime-config.js";

/**
 * docs/specs/kiln-sandbox-provider.md. The warm snapshot of one repository: the sandbox right after
 * the clone, the bootstrap and the warm command, before any agent runs. It is valid for one Kiln
 * template and one bootstrap key. A change of either makes a new snapshot (docs/specs/run-speed.md).
 */
export interface WarmSnapshot {
  tenantId: string;
  /** The adapter that holds the snapshot. A snapshot id means nothing to another adapter. */
  adapter: string;
  /**
   * The repository URL of a one-repository snapshot. docs/specs/change-sets.md, DI-21.135: the
   * subject of a set snapshot, `snapshotSubjectOf` its repository URLs.
   */
  repositoryUrl: string;
  /**
   * docs/specs/change-sets.md, DI-21.135. The sorted repository URLs a set snapshot holds. Absent
   * for a snapshot of one repository.
   */
  repositoryUrls?: string[];
  /** docs/specs/kiln-sandbox-size.md. The template the snapshot holds: the image digest and the size. */
  template: string;
  /** docs/specs/run-speed.md. The bootstrap key of the configuration the snapshot ran. */
  bootstrapKey: string;
  /** The exit code of a failed warm command, or null when it passed or none ran. */
  warmCommandExitCode: number | null;
  snapshotId: string;
}

/** One file of a repository, by its path and its git blob SHA. */
export interface RepositoryFileEntry {
  path: string;
  sha: string;
}

/** The inputs that decide what a warm snapshot holds. */
export interface BootstrapInputs {
  bootstrapCommand: string | null;
  warmCommand: string | null;
  /** The effective allow list of the repository: the Product list narrowed by the repository. */
  allowedDomains: readonly string[];
  /** docs/specs/repository-setup-and-services.md. The compose stack the warm phase starts. */
  services?: ServicesConfig | null;
  docker?: boolean;
  /** docs/specs/repository-setup-and-services.md. The key files, by path and blob SHA. */
  files?: readonly RepositoryFileEntry[];
  /**
   * docs/specs/host-credentials.md. Each host credential of the product: its host, its redirect
   * hosts and, for `github`, its repositories. A secret or a token rotation is not part of it.
   */
  credentials?: readonly string[];
}

/** The config file itself. Its fields that change a snapshot are already in the key. */
const CONFIG_FILE = ".factoree/config.yaml";

/**
 * docs/specs/repository-setup-and-services.md. The globs whose files key the warm snapshot: the
 * repository's key files, its compose file, and everything under `.factoree/` but the config file.
 */
export const keyFilePatternsOf = (runtime: Pick<ProjectRuntimeConfig, "keyFiles" | "services">): string[] => [
  ...new Set([...(runtime.keyFiles ?? []), ...(runtime.services ? [runtime.services.compose] : []), ".factoree/**"]),
];

/** The files of a repository that match the key file globs, sorted by path. */
export const selectKeyFiles = (
  files: readonly RepositoryFileEntry[],
  patterns: readonly string[],
): RepositoryFileEntry[] =>
  files
    .filter((file) => file.path !== CONFIG_FILE && patterns.some((pattern) => path.posix.matchesGlob(file.path, pattern)))
    .map((file) => ({ path: file.path, sha: file.sha }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

/**
 * docs/specs/run-speed.md, amended by docs/specs/repository-setup-and-services.md. The SHA-256 of
 * the bootstrap command, the warm command, the effective bootstrap allow list, the compose stack
 * and the key files. Only these change what a warm snapshot holds, so a change to `verify`,
 * `agents`, `preview` or `identity` keeps the snapshot. A repository with no stack and no key file
 * keeps the key it had before these inputs existed, so its snapshot stays valid.
 */
export const bootstrapKeyOf = (inputs: BootstrapInputs): string => {
  const services = inputs.services ?? null;
  const files = inputs.files ?? [];
  return createHash("sha256")
    .update(
      JSON.stringify({
        bootstrap: inputs.bootstrapCommand,
        warm: inputs.warmCommand,
        allowedDomains: [...new Set(inputs.allowedDomains)].sort(),
        ...(services === null ? {} : { services }),
        ...(inputs.docker === true && services === null ? { docker: true } : {}),
        ...(files.length === 0 ? {} : { files: files.map((file) => [file.path, file.sha]) }),
        ...((inputs.credentials ?? []).length === 0 ? {} : { credentials: [...(inputs.credentials ?? [])].sort() }),
      }),
    )
    .digest("hex");
};

/**
 * docs/specs/change-sets.md, DI-21.135. The subject of a warm snapshot: the repository URL of one
 * repository, or the sorted URLs of a set joined by a space. A URL holds no space, and the subject
 * of one repository is its URL, so every snapshot of one repository keeps its row.
 */
export const snapshotSubjectOf = (repositoryUrls: readonly string[]): string => [...new Set(repositoryUrls)].sort().join(" ");

/** One repository of a set and the bootstrap key of its configuration. */
export interface SetMemberKey {
  repositoryUrl: string;
  bootstrapKey: string;
}

/**
 * docs/specs/change-sets.md, DI-21.135. The key of a set snapshot: the SHA-256 of the sorted list
 * of repository and bootstrap key, one line each. The key of one repository is its bootstrap key,
 * so a snapshot of one repository keeps its key.
 */
export const setBootstrapKeyOf = (members: readonly SetMemberKey[]): string => {
  const only = members.length === 1 ? members[0] : undefined;
  if (only !== undefined) return only.bootstrapKey;
  const lines = members.map((member) => `${member.repositoryUrl} ${member.bootstrapKey}`).sort();
  return createHash("sha256").update(`${lines.join("\n")}\n`).digest("hex");
};

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

/** One warm snapshot per tenant, adapter and subject: a repository or a set. A new one replaces the old one. */
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
