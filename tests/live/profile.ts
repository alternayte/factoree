/**
 * SDD section 66. The live acceptance test runs under one of two profiles.
 *
 * The `full` profile demands every real SDD section 66 dependency. It is the default. The
 * `local` profile substitutes local infrastructure for the Fly Sprite, the Temporal service,
 * the Backstage catalog, and the MCP source. A `local` run proves the scenario code, not SDD
 * section 66. Read `docs/build/local-harness-plan.md` for the rule this file must not weaken.
 */
import { REQUIRED_LIVE_CREDENTIALS, type LiveCredential } from "./required-credentials.js";

export type LiveProfile = "local" | "full";

const LOCAL_DEPENDENCIES: LiveCredential["dependency"][] = ["linear", "github", "runner"];

/** The local endpoint values that replace the Temporal Cloud, Backstage, and MCP credentials. */
const LOCAL_REPLACEMENT_CREDENTIALS: LiveCredential[] = [
  {
    name: "LIVE_LOCAL_TEMPORAL_ADDRESS",
    dependency: "temporal",
    description: "The host and port of the local Temporal dev server.",
  },
  {
    name: "LIVE_LOCAL_TEMPORAL_NAMESPACE",
    dependency: "temporal",
    description: "The Temporal namespace the local dev server uses.",
  },
  {
    name: "LIVE_LOCAL_BACKSTAGE_BASE_URL",
    dependency: "backstage",
    description: "The base URL of the local Backstage stub.",
  },
  {
    name: "LIVE_LOCAL_MCP_ENDPOINT",
    dependency: "mcp",
    description: "The endpoint of the local MCP stub.",
  },
];

/**
 * Derive the local credential list from the full list by dependency. The local profile keeps
 * `linear`, `github`, and `runner` unchanged, drops every `fly-sprites` credential, and
 * replaces the `temporal`, `backstage`, and `mcp` credentials with local endpoint values.
 */
const buildLocalCredentials = (): LiveCredential[] => [
  ...REQUIRED_LIVE_CREDENTIALS.filter((entry) => LOCAL_DEPENDENCIES.includes(entry.dependency)),
  ...LOCAL_REPLACEMENT_CREDENTIALS,
];

const CREDENTIALS_BY_PROFILE: Record<LiveProfile, LiveCredential[]> = {
  full: REQUIRED_LIVE_CREDENTIALS,
  local: buildLocalCredentials(),
};

/** The credential list of one profile. The full list is the anti-weakening guard. */
export const credentialsFor = (profile: LiveProfile): LiveCredential[] =>
  CREDENTIALS_BY_PROFILE[profile];

/**
 * Resolve the profile from the environment. A missing or empty variable resolves to `full`,
 * the strict profile. An unknown value throws, so a typo never downgrades the proof.
 */
export const resolveProfile = (env: NodeJS.ProcessEnv): LiveProfile => {
  const value = env.FACTOREE_LIVE_PROFILE;
  if (value === undefined || value.trim() === "") return "full";
  if (value === "local" || value === "full") return value;
  throw new Error(
    `FACTOREE_LIVE_PROFILE has the unknown value "${value}". Use "local" or "full".`,
  );
};

export const PROFILE_BANNER: Record<LiveProfile, string> = {
  full: [
    "SDD SECTION 66 LIVE ACCEPTANCE",
    "",
    "This run uses every real dependency SDD section 66 names.",
    "A pass here is SDD section 66 proof.",
  ].join("\n"),
  local: [
    "LOCAL LIVE ACCEPTANCE",
    "",
    "This run uses local infrastructure in place of the Fly Sprite, the Temporal",
    "service, the Backstage catalog, and the MCP source.",
    "It proves the scenario code.",
    "It is NOT SDD SECTION 66 PROOF.",
  ].join("\n"),
};
