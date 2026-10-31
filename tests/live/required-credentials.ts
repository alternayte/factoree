/**
 * SDD section 66. Every entry below names one value the live acceptance path genuinely reads.
 *
 * The driver credentials are the four values `tests/live/scenario.ts` reads. The scenario acts
 * as the human operator: it creates a Linear issue and delegates it. The application itself
 * keeps its own Linear and GitHub credentials in the database, not in the environment.
 *
 * The infrastructure requirements name variables `src/config/env.ts` reads. A profile can
 * demand a variable be present, or demand it equal one exact value. `SANDBOX_ADAPTER` is the
 * second kind, because the wrong adapter value must be reported as wrong, not as absent.
 */
export type RequirementKind = "present" | "equals";

export interface LiveRequirement {
  /** The environment variable name. */
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
    name: "DATABASE_URL",
    dependency: "database",
    kind: "present",
    description: "The PostgreSQL connection string src/config/env.ts requires.",
  },
  {
    name: "TEMPORAL_ADDRESS",
    dependency: "temporal",
    kind: "present",
    description: "The host and port of the Temporal service src/config/env.ts reads.",
  },
  {
    name: "TEMPORAL_NAMESPACE",
    dependency: "temporal",
    kind: "present",
    description: "The Temporal namespace src/config/env.ts reads.",
  },
];

/** The `local` profile must prove the worker selects the local sandbox adapter. */
export const LOCAL_SANDBOX_REQUIREMENT: LiveRequirement = {
  name: "SANDBOX_ADAPTER",
  dependency: "sandbox",
  kind: "equals",
  value: "local",
  description: "src/config/env.ts must select the local sandbox adapter for this profile.",
};

/** The `sprite` and `full` profiles must prove the worker uses a real Fly Sprite. */
export const SPRITE_SANDBOX_REQUIREMENTS: LiveRequirement[] = [
  {
    name: "SANDBOX_ADAPTER",
    dependency: "sandbox",
    kind: "equals",
    value: "fly-sprites",
    description: "src/config/env.ts must select the Fly Sprites sandbox adapter for this profile.",
  },
  {
    name: "SPRITES_TOKEN",
    dependency: "sandbox",
    kind: "present",
    description: "The Fly.io token src/config/env.ts requires when SANDBOX_ADAPTER is fly-sprites.",
  },
];

/**
 * docs/specs/kiln-sandbox-provider.md. With SANDBOX_ADAPTER=kiln, the `full` profile proves the
 * worker uses a real Kiln sandbox from the Factoree sandbox image.
 */
export const KILN_SANDBOX_REQUIREMENTS: LiveRequirement[] = [
  {
    name: "SANDBOX_ADAPTER",
    dependency: "sandbox",
    kind: "equals",
    value: "kiln",
    description: "src/config/env.ts must select the Kiln sandbox adapter for this profile.",
  },
  {
    name: "KILN_URL",
    dependency: "sandbox",
    kind: "present",
    description: "The Kiln host src/config/env.ts requires when SANDBOX_ADAPTER is kiln.",
  },
  {
    name: "KILN_API_KEY",
    dependency: "sandbox",
    kind: "present",
    description: "A key of the Factoree tenant on the Kiln host.",
  },
  {
    name: "KILN_IMAGE",
    dependency: "sandbox",
    kind: "present",
    description: "The Factoree sandbox image by digest, from the sandbox-image workflow.",
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
