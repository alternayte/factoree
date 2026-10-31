/**
 * SDD section 66. The live acceptance test runs under one of three profiles.
 *
 * The `full` profile demands every real SDD section 66 dependency. It is the default. The
 * `local` profile substitutes local infrastructure for the Fly Sprite, the Backstage catalog,
 * and the MCP source. The `sprite` profile is the `local` profile plus a real Fly Sprite, for
 * an operator who debugs the Sprite integration without a Backstage instance and without a
 * Temporal Cloud account. A `local` or `sprite` run proves the scenario code, not SDD section
 * 66.
 *
 * Every profile requires the four driver credentials of `required-credentials.ts`, plus a real
 * database and a real Temporal service, because both the worker and the scenario need them to
 * run. Only the sandbox provider requirement differs between the profiles. The provider is an
 * install setting, so `install-facts.ts` reads it from the database before the check.
 */
import {
  COMMON_INFRASTRUCTURE_REQUIREMENTS,
  DRIVER_CREDENTIALS,
  KILN_SANDBOX_REQUIREMENTS,
  INSTALL_SANDBOX_PROVIDER,
  LOCAL_SANDBOX_REQUIREMENTS,
  SPRITE_SANDBOX_REQUIREMENTS,
  type LiveRequirement,
} from "./required-credentials.js";

export type LiveProfile = "local" | "sprite" | "full";

const commonRequirements: LiveRequirement[] = [...DRIVER_CREDENTIALS, ...COMMON_INFRASTRUCTURE_REQUIREMENTS];

const REQUIREMENTS_BY_PROFILE: Record<LiveProfile, LiveRequirement[]> = {
  local: [...commonRequirements, ...LOCAL_SANDBOX_REQUIREMENTS],
  sprite: [...commonRequirements, ...SPRITE_SANDBOX_REQUIREMENTS],
  full: [...commonRequirements, ...SPRITE_SANDBOX_REQUIREMENTS],
};

/**
 * The requirement list of one profile. The full list is the anti-weakening guard. A `full` run
 * on Kiln swaps the Sprite requirements for the Kiln ones, and keeps every other requirement.
 */
export const credentialsFor = (profile: LiveProfile, facts: NodeJS.ProcessEnv = {}): LiveRequirement[] =>
  profile === "full" && facts[INSTALL_SANDBOX_PROVIDER] === "kiln"
    ? [...commonRequirements, ...KILN_SANDBOX_REQUIREMENTS]
    : REQUIREMENTS_BY_PROFILE[profile];

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
    "This run uses every real dependency SDD section 66 names, on Fly Sprites or on Kiln.",
    "A pass on this run is SDD section 66 proof. A failure is not.",
  ].join("\n"),
  local: [
    "LOCAL LIVE ACCEPTANCE",
    "",
    "This run uses local infrastructure in place of the Fly Sprite, the Backstage catalog,",
    "and the MCP source.",
    "It proves the scenario code.",
    "It is NOT SDD SECTION 66 PROOF.",
  ].join("\n"),
  sprite: [
    "SPRITE LIVE ACCEPTANCE",
    "",
    "This run uses a real Fly Sprite, and local infrastructure in place of the",
    "Backstage catalog and the MCP source.",
    "It proves the Sprite integration and the scenario code.",
    "It is NOT SDD SECTION 66 PROOF.",
  ].join("\n"),
};
