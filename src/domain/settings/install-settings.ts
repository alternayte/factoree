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

export interface SandboxSettings {
  provider: SandboxProvider | null;
  /**
   * The Kiln host, the Sprites API base URL, or the URL of a self-hosted E2B, whose host name is the
   * E2B domain. Null means the provider default.
   */
  url: string | null;
  apiKey: string | null;
  /** A sandbox image by digest, over the image the release pins. */
  image: string | null;
  registryUsername: string | null;
  registryToken: string | null;
  /** The provider's limit of live sandboxes. The worker enforces it (DI-15.14). */
  maxLive: number | null;
  /** docs/specs/kiln-sandbox-size.md. The vCPUs of each Kiln sandbox. Null means the default. */
  vcpus: number | null;
  /** docs/specs/kiln-sandbox-size.md. The memory of each Kiln sandbox in MB. Null means the default. */
  memoryMb: number | null;
}

/** docs/specs/kiln-sandbox-size.md. The vCPUs and the memory of a Kiln sandbox, fixed by its template. */
export interface KilnSandboxSize {
  vcpus: number;
  memoryMb: number;
}

export const DEFAULT_KILN_SANDBOX_SIZE: KilnSandboxSize = { vcpus: 4, memoryMb: 4096 };

/** The size of each Kiln sandbox: the stored values, or the default. */
export const kilnSandboxSize = (settings: SandboxSettings): KilnSandboxSize => ({
  vcpus: settings.vcpus ?? DEFAULT_KILN_SANDBOX_SIZE.vcpus,
  memoryMb: settings.memoryMb ?? DEFAULT_KILN_SANDBOX_SIZE.memoryMb,
});

export interface GitAuthorSettings {
  name: string;
  email: string;
}

export interface InstallSettings {
  github: GitHubAppSettings;
  linear: LinearAppSettings;
  sandbox: SandboxSettings;
  gitAuthor: GitAuthorSettings;
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
