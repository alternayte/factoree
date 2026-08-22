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
