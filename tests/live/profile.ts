/**
 * SDD section 66. The live acceptance test runs under one of three profiles.
 *
 * The `full` profile demands every real SDD section 66 dependency. It is the default. The
 * `local` profile substitutes local infrastructure for the Fly Sprite, the Temporal service,
 * the Backstage catalog, and the MCP source. The `sprite` profile is the `local` profile plus a
 * real Fly Sprite, for an operator who debugs the Sprite integration without a Backstage
 * instance and without a Temporal Cloud account. A `local` or `sprite` run proves the scenario
 * code, not SDD section 66. Read `docs/build/local-harness-plan.md` for the rule this file must
 * not weaken.
 */
import { REQUIRED_LIVE_CREDENTIALS, type LiveCredential } from "./required-credentials.js";

export type LiveProfile = "local" | "sprite" | "full";

export const LOCAL_DEPENDENCIES: LiveCredential["dependency"][] = ["linear", "github", "runner"];

/** The dependency SDD section 66 names that the local profile drops on purpose. The Fly Sprite
 * has no local stand-in, so the local profile demands no credential for it. */
export const LOCAL_EXCLUDED_DEPENDENCIES: LiveCredential["dependency"][] = ["fly-sprites"];

/** The local endpoint values that replace the Temporal Cloud, Backstage, and MCP credentials. */
export const LOCAL_REPLACEMENT_CREDENTIALS: LiveCredential[] = [
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

/**
 * Derive the sprite credential list from the local list, not by a hand-written third list. The
 * sprite profile keeps every local credential and adds every `fly-sprites` credential of
 * `REQUIRED_LIVE_CREDENTIALS`. A future `fly-sprites` credential added to the full list reaches
 * the sprite profile automatically, because this filters by dependency rather than by name.
 */
const buildSpriteCredentials = (): LiveCredential[] => [
  ...buildLocalCredentials(),
  ...REQUIRED_LIVE_CREDENTIALS.filter((entry) => entry.dependency === "fly-sprites"),
];

const CREDENTIALS_BY_PROFILE: Record<LiveProfile, LiveCredential[]> = {
  full: REQUIRED_LIVE_CREDENTIALS,
  local: buildLocalCredentials(),
  sprite: buildSpriteCredentials(),
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
  if (value === "local" || value === "sprite" || value === "full") return value;
  throw new Error(
    `FACTOREE_LIVE_PROFILE has the unknown value "${value}". Use "local", "sprite", or "full".`,
  );
};

export const PROFILE_BANNER: Record<LiveProfile, string> = {
  full: [
    "SDD SECTION 66 LIVE ACCEPTANCE",
    "",
    "This run uses every real dependency SDD section 66 names.",
    "A pass on this run is SDD section 66 proof. A failure is not.",
  ].join("\n"),
  local: [
    "LOCAL LIVE ACCEPTANCE",
    "",
    "This run uses local infrastructure in place of the Fly Sprite, the Temporal",
    "service, the Backstage catalog, and the MCP source.",
    "It proves the scenario code.",
    "It is NOT SDD SECTION 66 PROOF.",
  ].join("\n"),
  sprite: [
    "SPRITE LIVE ACCEPTANCE",
    "",
    "This run uses a real Fly Sprite, and local infrastructure in place of the",
    "Temporal service, the Backstage catalog, and the MCP source.",
    "It proves the Sprite integration and the scenario code.",
    "It is NOT SDD SECTION 66 PROOF.",
  ].join("\n"),
};
