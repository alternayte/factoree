/**
 * SDD section 66. Every entry below names one value the live acceptance path genuinely reads.
 *
 * The driver credentials are the four values `tests/live/scenario.ts` reads. The scenario acts
 * as the human operator: it creates a Linear issue and delegates it. The application itself
 * keeps its own Linear and GitHub credentials in the database, not in the environment.
 *
 * The infrastructure requirements name variables `src/config/env.ts` reads, and install settings
 * the worker reads from the database. A profile can demand a value be present, or demand it
 * equal one exact value. The sandbox provider is the second kind, because the wrong provider
 * must be reported as wrong, not as absent.
 */
export type RequirementKind = "present" | "equals";

export interface LiveRequirement {
  /** The environment variable name, or an `install.*` name of `install-facts.ts`. */
  name: string;
  /** The dependency this requirement reaches. */
  dependency: "linear" | "github" | "database" | "temporal" | "sandbox";
  /** "present" demands a non-empty value. "equals" demands the value named by `value`. */
  kind: RequirementKind;
  /** The exact value an "equals" requirement demands. Absent for a "present" requirement. */
  value?: string;
  /** What an operator must put in it. */
  description: string;
}

/** The exact four values `tests/live/scenario.ts` reads, and nothing more. */
export const DRIVER_CREDENTIALS: LiveRequirement[] = [
  {
    name: "LIVE_LINEAR_API_KEY",
    dependency: "linear",
    kind: "present",
    description: "A personal API key of the Linear test workspace.",
  },
  {
    name: "LIVE_LINEAR_TEAM_ID",
    dependency: "linear",
    kind: "present",
    description: "The Linear team the live test creates its fixture issue in.",
  },
  {
    name: "LIVE_GITHUB_TOKEN",
    dependency: "github",
    kind: "present",
    description: "A token with write access to the GitHub fixture repository only.",
  },
  {
    name: "LIVE_GITHUB_REPOSITORY",
    dependency: "github",
    kind: "present",
    description: "The fixture repository, as owner/name. It must not be a production repository.",
  },
];

/** Every profile needs a real database and a real Temporal service to run the worker against. */
export const COMMON_INFRASTRUCTURE_REQUIREMENTS: LiveRequirement[] = [
  {
    name: "FACTOREE_DATABASE_URL",
    dependency: "database",
    kind: "present",
    description: "The PostgreSQL connection string src/config/env.ts requires.",
  },
  {
    name: "FACTOREE_TEMPORAL_ADDRESS",
    dependency: "temporal",
    kind: "present",
    description: "The host and port of the Temporal service src/config/env.ts reads.",
  },
  {
    name: "FACTOREE_TEMPORAL_NAMESPACE",
    dependency: "temporal",
    kind: "present",
    description: "The Temporal namespace src/config/env.ts reads.",
  },
];

/**
 * docs/specs/release-0-1-0.md. The sandbox provider and its key are install settings in the
 * database, not environment values. `install-facts.ts` reads them under these names, so a
 * requirement checks what the worker actually reads.
 */
export const INSTALL_SANDBOX_PROVIDER = "install.sandbox.provider";
export const INSTALL_SANDBOX_API_KEY = "install.sandbox.apiKey";
export const INSTALL_SANDBOX_URL = "install.sandbox.url";
export const INSTALL_SANDBOX_IMAGE = "install.sandbox.image";

/**
 * The `local` profile must prove the worker selects the local sandbox adapter, and that the
 * worker accepts it: the settings refuse the local provider without the unsafe opt in.
 */
export const LOCAL_SANDBOX_REQUIREMENTS: LiveRequirement[] = [
  {
    name: INSTALL_SANDBOX_PROVIDER,
    dependency: "sandbox",
    kind: "equals",
    value: "local",
    description: "The install settings must name the local sandbox provider for this profile.",
  },
  {
    name: "FACTOREE_UNSAFE_LOCAL_SANDBOX",
    dependency: "sandbox",
    kind: "equals",
    value: "1",
    description: "The worker accepts the local sandbox only with this opt in, on a development machine.",
  },
];

/** The `sprite` and `full` profiles must prove the worker uses a real Fly Sprite. */
export const SPRITE_SANDBOX_REQUIREMENTS: LiveRequirement[] = [
  {
    name: INSTALL_SANDBOX_PROVIDER,
    dependency: "sandbox",
    kind: "equals",
    value: "fly-sprites",
    description: "The install settings must name the Fly Sprites sandbox provider for this profile.",
  },
  {
    name: INSTALL_SANDBOX_API_KEY,
    dependency: "sandbox",
    kind: "present",
    description: "The Fly.io token, stored in Settings > Install.",
  },
];

/**
 * docs/specs/kiln-sandbox-provider.md. With the Kiln provider, the `full` profile proves the
 * worker uses a real Kiln sandbox from the Factoree sandbox image.
 */
export const KILN_SANDBOX_REQUIREMENTS: LiveRequirement[] = [
  {
    name: INSTALL_SANDBOX_PROVIDER,
    dependency: "sandbox",
    kind: "equals",
    value: "kiln",
    description: "The install settings must name the Kiln sandbox provider for this profile.",
  },
  {
    name: INSTALL_SANDBOX_URL,
    dependency: "sandbox",
    kind: "present",
    description: "The Kiln host, stored in Settings > Install.",
  },
  {
    name: INSTALL_SANDBOX_API_KEY,
    dependency: "sandbox",
    kind: "present",
    description: "A key of the Factoree tenant on the Kiln host, stored in Settings > Install.",
  },
  {
    name: INSTALL_SANDBOX_IMAGE,
    dependency: "sandbox",
    kind: "present",
    description: "The Factoree sandbox image by digest: the image override, or the image the release pins.",
  },
];

/** One requirement the environment does not meet, with the actual value it found, if any. */
export interface UnmetRequirement {
  requirement: LiveRequirement;
  /** The trimmed environment value, or undefined when the variable is absent or empty. */
  actual: string | undefined;
}

/** Every requirement of the given list the environment does not meet. An empty value counts as
 * absent. A wrong value on an "equals" requirement counts as unmet too, and carries its actual
 * value, so the report can tell an operator the value is wrong rather than absent. */
export const unmetRequirementsFor = (
  env: NodeJS.ProcessEnv,
  requirements: LiveRequirement[],
): UnmetRequirement[] => {
  const unmet: UnmetRequirement[] = [];
  for (const requirement of requirements) {
    const raw = env[requirement.name];
    const value = raw === undefined || raw.trim() === "" ? undefined : raw;
    if (value === undefined) {
      unmet.push({ requirement, actual: undefined });
      continue;
    }
    if (requirement.kind === "equals" && value !== requirement.value) {
      unmet.push({ requirement, actual: value });
    }
  }
  return unmet;
};
