/**
 * The typed sandbox and runner configuration for one Project. Phase 3 builds the
 * `.factoree/config.yaml` loader that produces this value. SDD section 15 describes the source
 * file. Phase 2 receives the value already built, so nothing here parses YAML.
 */
export interface ProjectRuntimeConfig {
  bootstrapCommand: string | null;
  /** SDD section 29. An empty list denies all egress. */
  allowedDomains: string[];
  implementerRunner: string;
  validatorRunner: string;
  reviewerRunner: string;
  repairMaxAttempts: number;
  stagingRead: boolean;
  /** SDD section 51. */
  spriteRetentionHours: number;
}

export const DEFAULT_PROJECT_RUNTIME_CONFIG: ProjectRuntimeConfig = {
  bootstrapCommand: null,
  allowedDomains: [],
  implementerRunner: "opencode",
  validatorRunner: "claude",
  reviewerRunner: "claude",
  repairMaxAttempts: 2,
  stagingRead: false,
  spriteRetentionHours: 24,
};

import type { FactoreeConfig } from "~/domain/products/factoree-config.js";
import { narrowAllowList } from "./sandbox.js";

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
 * verification commands, the runner names, the repair limit, and the egress allow list. The
 * Project owns staging read and the sandbox retention window.
 */
export const toProjectRuntimeConfig = (
  config: FactoreeConfig,
  defaults: ProjectDefaults,
): ResolvedProjectConfig => ({
  runtime: {
    bootstrapCommand: config.bootstrap?.command ?? null,
    // The same normalisation the sandbox applies, so the value carried on the Run and the value
    // sent to the adapter can never differ.
    allowedDomains: narrowAllowList(config.sandbox.allowedDomains, defaults.allowedDomains),
    implementerRunner: config.agents.implementer,
    validatorRunner: config.agents.validator,
    reviewerRunner: config.agents.reviewer,
    repairMaxAttempts: config.repair.maxAttempts,
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
});
