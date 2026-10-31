import type { AutonomyLevel } from "@/lib/workspace";

/**
 * The policy help text of issue 7, in one module, so the setup step and the product page show
 * the same words. The levels follow docs/specs/autonomy-levels.md, which amends SDD §27 and §28.
 * The text follows ASD-STE100: one statement per sentence, active voice, present tense.
 */

export type HelpLevel = AutonomyLevel | "L4";

export type LevelHelp = {
  level: HelpLevel;
  name: string;
  /** The short line each option of an autonomy dropdown shows. */
  summary: string;
  /** What Factoree does alone at the level, and where it stops for a human. */
  detail: string;
};

export const AUTONOMY_HELP: readonly LevelHelp[] = [
  {
    level: "L0",
    name: "Investigate",
    summary: "Reads and reports. Changes no code.",
    detail: "Factoree freezes the context contract and posts a report in Linear. It stops there. No agent changes code.",
  },
  {
    level: "L1",
    name: "Implement",
    summary: "Implements and checks. Opens no pull request.",
    detail:
      "Factoree implements the change in a sandbox and runs the checks. It posts the evidence in Linear and stops. It opens no pull request.",
  },
  {
    level: "L2",
    name: "Verified PR",
    summary: "Runs every check. Opens a draft pull request.",
    detail:
      "Factoree runs every check that L3 runs and opens a draft pull request. A human marks it ready and merges it.",
  },
  {
    level: "L3",
    name: "Reviewed PR",
    summary: "Runs every check. Opens a pull request ready for review.",
    detail:
      "Factoree runs every check, opens a pull request that is ready for review, and posts the proof pack. A human reviews and merges it.",
  },
  {
    level: "L4",
    name: "Merge",
    summary: "Reserved. Factoree never merges.",
    detail: "The SDD reserves this level. Version 1 never merges, so you cannot select it.",
  },
];

export const AUTONOMY_NOTES: readonly string[] = [
  "Each level stops earlier on the L3 path. A lower level is always the safer level.",
  "A pending product runs at L0.",
  "A human always merges.",
];

export function levelHelp(level: HelpLevel): LevelHelp {
  return AUTONOMY_HELP.find((help) => help.level === level) ?? AUTONOMY_HELP[2]!;
}

/** The text of one option of an autonomy dropdown: the level, its name and its line. */
export function autonomyOptionLabel(level: AutonomyLevel): string {
  const help = levelHelp(level);
  return `${level} · ${help.name} — ${help.summary}`;
}

export const RISK_CAPS_HELP: readonly string[] = [
  "A risk cap names a Linear label and the highest level that the label allows.",
  "A run gets the lowest level of the product default and the cap of each of its labels.",
  "The labels factoree:l0, factoree:l1 and factoree:l2 lower the level of one issue. No label raises it.",
  "When Factoree cannot read the labels, the run gets L2 at most.",
  "A new product caps the high-risk labels, for example security and payments, at L2.",
  "A run keeps the level it started with. A change applies to the next run.",
];

export const ALLOWED_DOMAINS_HELP: readonly string[] = [
  "This list is the egress allow list of every sandbox of the product. An agent reaches only these hosts.",
  "The .factoree/config.yaml of a repository can make the list shorter. It cannot add a host.",
  "During the bootstrap, the sandbox can also reach the git hosts of the repositories.",
  "*.example.com allows each subdomain of example.com. A wildcard needs two labels after the star.",
];
