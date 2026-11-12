/**
 * The typed sandbox and runner configuration for one Project. Phase 3 builds the
 * `.factoree/config.yaml` loader that produces this value. SDD section 15 describes the source
 * file. Phase 2 receives the value already built, so nothing here parses YAML.
 */
export interface ProjectRuntimeConfig {
  bootstrapCommand: string | null;
  /**
   * docs/specs/run-speed.md. The warm command, which runs only when Factoree takes a warm
   * snapshot. Absent in a history recorded before it existed.
   */
  warmCommand?: string | null;
  /** SDD section 29. An empty list denies all egress. */
  allowedDomains: string[];
  /**
   * docs/specs/egress-honesty-and-issue-status.md. True when `.factoree/config.yaml` declares a
   * non-empty `sandbox.allowedDomains`, which narrows the Product list. Absent in an old history.
   */
  sandboxAllowListDeclared?: boolean;
  /**
   * docs/specs/repository-setup-and-services.md. The globs of the files whose content keys the
   * warm snapshot. Absent in a history recorded before it existed.
   */
  keyFiles?: string[];
  /**
   * docs/specs/repository-setup-and-services.md. The ecosystem hosts the bootstrap phase adds to
   * the allow list. The agent phase never gets them. Absent in an old history.
   */
  bootstrapAllowedDomains?: string[];
  /** docs/specs/repository-setup-and-services.md. The compose stack, or null. Absent in an old history. */
  services?: ServicesConfig | null;
  /** docs/specs/repository-setup-and-services.md. True when the sandbox runs Docker. Absent in an old history. */
  docker?: boolean;
  /** docs/specs/repository-setup-and-services.md. The sign-in accounts. Absent in an old history. */
  accounts?: AccountConfig[];
  implementerRunner: string;
  validatorRunner: string;
  reviewerRunner: string;
  /** docs/specs/claude-code-runner.md. Absent in an old history, where the refiner took the validator runner. */
  refinerRunner?: string;
  /** docs/specs/claude-code-runner.md. True when `.factoree/config.yaml` holds an `agents` block Factoree ignored. */
  agentsBlockIgnored?: boolean;
  /** SDD section 42, DI-21.67. The effective repair budget of the run. */
  repairMaxAttempts: number;
  /**
   * Issue #43, DI-21.67. Where `repairMaxAttempts` comes from: the repository file or the Product
   * setting. Absent in a history recorded before the Product setting existed.
   */
  repairBudgetSource?: RepairBudgetSource;
  stagingRead: boolean;
  /** SDD section 51. */
  spriteRetentionHours: number;
}

/** The requested bootstrap hosts that the ecosystem host list covers. An empty request adds none. */
const ecosystemHostsOf = (requested: string[]): string[] =>
  requested.length === 0 ? [] : narrowAllowList(requested, [...ECOSYSTEM_HOSTS]);

/**
 * The allow list of the bootstrap phase: the repository allow list and its ecosystem bootstrap
 * hosts. It is part of the bootstrap key, because it decides what the bootstrap can install.
 */
export const bootstrapAllowListOf = (runtime: Pick<ProjectRuntimeConfig, "allowedDomains" | "bootstrapAllowedDomains">): string[] => [
  ...new Set([...runtime.allowedDomains, ...(runtime.bootstrapAllowedDomains ?? [])]),
];

/** docs/specs/repository-setup-and-services.md. The compose stack of a repository. */
export interface ServicesConfig {
  /** The compose file of the repository, relative to its root. */
  compose: string;
  profiles: string[];
  /** The command that fills the stack once, after the bootstrap, or null. */
  seed: string | null;
  waitTimeoutSeconds: number;
}

/** docs/specs/repository-setup-and-services.md. One account a browser assertion can sign in as. */
export interface AccountConfig {
  name: string;
  username: string;
  password: string;
  /** The sign-in steps. A fill value may name {username} and {password}. */
  steps: SignInStep[];
  /** The step that proves the account is signed in. */
  check: Extract<SignInStep, { action: "expectText" | "expectVisible" }>;
}

export type SignInStep = Extract<BrowserStep, { action: "goto" | "click" | "fill" | "reload" | "expectText" | "expectVisible" }>;

export const DEFAULT_PROJECT_RUNTIME_CONFIG: ProjectRuntimeConfig = {
  bootstrapCommand: null,
  warmCommand: null,
  allowedDomains: [],
  implementerRunner: "opencode",
  validatorRunner: "opencode",
  reviewerRunner: "opencode",
  refinerRunner: "opencode",
  repairMaxAttempts: 2,
  stagingRead: false,
  spriteRetentionHours: 24,
};

import type { FactoreeConfig } from "~/domain/products/factoree-config.js";
import type { BrowserStep } from "~/domain/validation/validation-plan.js";
import { narrowAllowList } from "./sandbox.js";
import { ECOSYSTEM_HOSTS } from "~/domain/setup/ecosystem-hosts.js";
import { effectiveRepairBudget, type RepairBudgetSource } from "./repair-budget.js";

/** SDD section 35. One configured deterministic verification command. */
export interface VerificationCommand {
  /** The name recorded with the result. It is unique inside one Run. */
  name: string;
  /** The exact shell command. It runs through `sh -c` from a clean environment. */
  run: string;
}

/**
 * The Project-level values that `.factoree/config.yaml` must not own. A repository must not be
 * able to widen a control the operator set on the Project.
 */
export interface ProjectDefaults {
  stagingRead: boolean;
  spriteRetentionHours: number;
  /** R-4. The egress ceiling of the Product. The repository file can only narrow it. */
  allowedDomains: string[];
  /**
   * docs/specs/claude-code-runner.md. The runner of each role of a run, as the Product resolves
   * it. Absent means opencode for every role: a build-ahead or a setup proof starts no session.
   */
  runners?: RunRunners;
  /**
   * Issue #43, DI-21.67. The repair budget of the Product, which a repository that sets
   * `repair.maxAttempts` replaces. Absent means the SDD default of 2.
   */
  repairMaxAttempts?: number;
}

/** docs/specs/claude-code-runner.md. The runner of each role that a run starts. */
export interface RunRunners {
  refiner: string;
  implementer: string;
  validator: string;
  reviewer: string;
}

export const DEFAULT_PROJECT_DEFAULTS: ProjectDefaults = {
  stagingRead: false,
  spriteRetentionHours: 24,
  allowedDomains: [],
};

/** SDD section 15 and SDD section 37. The preview the User Validator starts. */
export interface PreviewConfig {
  enabled: boolean;
  /** The exact shell command. It runs through `sh -c` from the primary worktree. */
  command: string;
  /** The URL the readiness poll requests. Its port is the port Factoree exposes. */
  readyUrl: string;
  timeoutSeconds: number;
}

export interface ResolvedProjectConfig {
  runtime: ProjectRuntimeConfig;
  verifyCommands: VerificationCommand[];
  preview: PreviewConfig | null;
}

/**
 * SDD section 15 and section 57. Produces the runtime configuration of one Run from the
 * repository file and the Project defaults. The repository owns the bootstrap command, the
 * verification commands and the egress allow list. The Project owns staging read, the sandbox
 * retention window and the runner of each role. The repair budget is the repository's when the
 * file sets one, and the Project's otherwise (DI-21.67).
 */
export const toProjectRuntimeConfig = (
  config: FactoreeConfig,
  defaults: ProjectDefaults,
): ResolvedProjectConfig => {
  const repair = effectiveRepairBudget(config.repair.maxAttempts, defaults.repairMaxAttempts);
  return {
    runtime: {
      bootstrapCommand: config.bootstrap?.command ?? null,
      warmCommand: config.warm?.command ?? null,
      // The same normalisation the sandbox applies, so the value carried on the Run and the value
      // sent to the adapter can never differ.
      allowedDomains: narrowAllowList(config.sandbox.allowedDomains, defaults.allowedDomains),
      sandboxAllowListDeclared: config.sandbox.allowedDomains.length > 0,
      keyFiles: config.bootstrap?.keyFiles ?? [],
      bootstrapAllowedDomains: ecosystemHostsOf(config.bootstrap?.allowedDomains ?? []),
      services:
        config.services === null
          ? null
          : {
              compose: config.services.compose,
              profiles: config.services.profiles,
              seed: config.services.seed,
              waitTimeoutSeconds: config.services.waitTimeoutSeconds,
            },
      docker: config.docker || config.services !== null,
      accounts: config.accounts.map((account) => ({
        name: account.name,
        username: account.username,
        password: account.password,
        steps: account.steps,
        check: account.check,
      })),
      implementerRunner: defaults.runners?.implementer ?? "opencode",
      validatorRunner: defaults.runners?.validator ?? "opencode",
      reviewerRunner: defaults.runners?.reviewer ?? "opencode",
      refinerRunner: defaults.runners?.refiner ?? "opencode",
      agentsBlockIgnored: config.agents !== undefined,
      repairMaxAttempts: repair.maxAttempts,
      repairBudgetSource: repair.source,
      stagingRead: defaults.stagingRead,
      spriteRetentionHours: defaults.spriteRetentionHours,
    },
    verifyCommands: config.verify.commands.map((command) => ({ name: command.name, run: command.run })),
    preview:
      config.preview === null
        ? null
        : {
            enabled: config.preview.enabled,
            command: config.preview.command,
            readyUrl: config.preview.readyUrl,
            timeoutSeconds: config.preview.timeoutSeconds,
          },
  };
};
