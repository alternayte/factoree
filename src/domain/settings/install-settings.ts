/**
 * docs/specs/release-0-1-0.md. The install settings: the GitHub App, the Linear app, the sandbox
 * provider and the git author. They live in one database row, and no value has an environment
 * fallback. A credential is cipher text at rest under FACTOREE_MASTER_KEY, and plain text only
 * in this shape, in memory, for the one call that needs it.
 *
 * DI-14.49. A process reads the row for each use and caches nothing, so a change in the UI
 * applies to the next call with no restart. The sandbox adapter and the sign-in handler are the
 * two objects that hold a connection or a configuration, and each rebuilds itself when the
 * fingerprint of its own settings changes.
 */

export const SANDBOX_PROVIDERS = ["kiln", "e2b", "fly-sprites", "local"] as const;
export type SandboxProvider = (typeof SANDBOX_PROVIDERS)[number];

export interface GitHubAppSettings {
  appId: string | null;
  appSlug: string | null;
  clientId: string | null;
  clientSecret: string | null;
  /** The PEM of the App private key. */
  privateKey: string | null;
  webhookSecret: string | null;
  /** The web URL of GitHub, or of a GitHub Enterprise Server. */
  baseUrl: string;
  /** The REST API URL of GitHub, or of a GitHub Enterprise Server. */
  apiBaseUrl: string;
}

export interface LinearAppSettings {
  clientId: string | null;
  clientSecret: string | null;
  webhookSecret: string | null;
}

/**
 * The sandbox settings of the whole install. docs/specs/sandbox-provider-spillover.md: the
 * providers live in their own list (`SandboxProviderStore`), and every provider builds its
 * template from this one image.
 */
export interface SandboxSettings {
  /** A sandbox image by digest, over the image the release pins. */
  image: string | null;
  registryUsername: string | null;
  registryToken: string | null;
}

/** docs/specs/kiln-sandbox-size.md. The vCPUs and the memory of a Kiln sandbox, fixed by its template. */
export interface KilnSandboxSize {
  vcpus: number;
  memoryMb: number;
}

export const DEFAULT_KILN_SANDBOX_SIZE: KilnSandboxSize = { vcpus: 4, memoryMb: 4096 };

/** The size of each sandbox of a provider: the stored values, or the default. */
export const kilnSandboxSize = (settings: { vcpus: number | null; memoryMb: number | null }): KilnSandboxSize => ({
  vcpus: settings.vcpus ?? DEFAULT_KILN_SANDBOX_SIZE.vcpus,
  memoryMb: settings.memoryMb ?? DEFAULT_KILN_SANDBOX_SIZE.memoryMb,
});

/** docs/specs/sandbox-memory-and-size.md. The disk of a sandbox when no repository asks for more. */
export const DEFAULT_SANDBOX_DISK_MB = 16_384;

/** docs/specs/sandbox-memory-and-size.md. The vCPUs, memory and disk of one sandbox. */
export interface SandboxSize extends KilnSandboxSize {
  diskMb: number;
}

/**
 * docs/specs/sandbox-memory-and-size.md. The `sandbox` block of `.factoree/config.yaml`: the least
 * size a repository needs. A null field asks for nothing.
 */
export interface SandboxMinimum {
  vcpus: number | null;
  memoryMb: number | null;
  diskMb: number | null;
}

const larger = (left: number | null, right: number | null): number | null =>
  left === null ? right : right === null ? left : Math.max(left, right);

/** The size of a sandbox: per field the larger of the repository minimum and the provider size. */
export const sandboxSizeOf = (provider: KilnSandboxSize, minimum: SandboxMinimum | null): SandboxSize => ({
  vcpus: Math.max(provider.vcpus, minimum?.vcpus ?? 0),
  memoryMb: Math.max(provider.memoryMb, minimum?.memoryMb ?? 0),
  diskMb: Math.max(DEFAULT_SANDBOX_DISK_MB, minimum?.diskMb ?? 0),
});

/**
 * docs/specs/sandbox-memory-and-size.md. A change set holds every target in one sandbox, so it
 * needs the largest minimum of its targets, per field. Null when no target asks for anything.
 */
export const largestMinimum = (minimums: ReadonlyArray<SandboxMinimum | null>): SandboxMinimum | null => {
  let result: SandboxMinimum | null = null;
  for (const minimum of minimums) {
    if (minimum === null) continue;
    result =
      result === null
        ? { ...minimum }
        : {
            vcpus: larger(result.vcpus, minimum.vcpus),
            memoryMb: larger(result.memoryMb, minimum.memoryMb),
            diskMb: larger(result.diskMb, minimum.diskMb),
          };
  }
  return result;
};

export interface GitAuthorSettings {
  name: string;
  email: string;
}

/**
 * docs/specs/retro-agent.md. The S3-compatible bucket of kept transcripts. With no bucket, the
 * transcripts stay in Postgres. A `FACTOREE_TRANSCRIPT_S3_*` env var wins over each field.
 */
export interface TranscriptBucketSettings {
  endpoint: string | null;
  bucket: string | null;
  region: string | null;
  accessKey: string | null;
  secretKey: string | null;
}

export interface InstallSettings {
  github: GitHubAppSettings;
  linear: LinearAppSettings;
  sandbox: SandboxSettings;
  gitAuthor: GitAuthorSettings;
  transcriptBucket: TranscriptBucketSettings;
  /** The tenant whose Linear workspace admins administer these settings. Null before setup. */
  operatorTenantId: string | null;
  setupCompletedAt: Date | null;
}

/** A part of a settings section. An absent or undefined field keeps its value, and null clears it. */
export type SettingsPatch<Section> = { [Field in keyof Section]?: Section[Field] | undefined };

/** A change to the install settings. */
export interface InstallSettingsPatch {
  github?: SettingsPatch<GitHubAppSettings> | undefined;
  linear?: SettingsPatch<LinearAppSettings> | undefined;
  sandbox?: SettingsPatch<SandboxSettings> | undefined;
  gitAuthor?: SettingsPatch<GitAuthorSettings> | undefined;
  transcriptBucket?: SettingsPatch<TranscriptBucketSettings> | undefined;
  operatorTenantId?: string | null | undefined;
}

/** The section after a patch: each field the patch defines replaces the stored one. */
export const applyPatch = <Section extends object>(section: Section, patch: SettingsPatch<Section> | undefined): Section => ({
  ...section,
  ...Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined)),
});

export interface InstallSettingsStore {
  read(): Promise<InstallSettings>;
  update(patch: InstallSettingsPatch): Promise<InstallSettings>;
  /** The SHA-256 of the setup token, or null when none was issued. */
  setupTokenHash(): Promise<string | null>;
  storeSetupTokenHash(hash: string): Promise<void>;
  /** Ends setup. The token hash is cleared, so the token never works again. */
  completeSetup(at: Date): Promise<void>;
}

/** A setting a call needs and the operator has not stored. The message names the screen. */
export class InstallSettingMissingError extends Error {
  constructor(readonly setting: string) {
    super(`The install settings hold no ${setting}. Store it in Settings > Install, or finish setup.`);
    this.name = "InstallSettingMissingError";
  }
}

/** Returns the value, or throws the error that names the missing setting. */
export const requireSetting = <T>(value: T | null, setting: string): T => {
  if (value === null) throw new InstallSettingMissingError(setting);
  return value;
};
