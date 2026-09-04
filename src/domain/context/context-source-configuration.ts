import { z } from "zod";
import { AUTHORITY_CLASSES, type AuthorityClass } from "./authority.js";

/**
 * SDD section 53 requires a `ContextSourceConfiguration` entity. SDD section 17 fixes the source
 * list of Version 1. Linear and the GitHub repositories are always present and need no row, so a
 * row configures a Backstage catalog or a generic MCP server only.
 */
export const CONTEXT_SOURCE_KINDS = ["backstage", "mcp"] as const;

export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];

/** The identifiers the built-in sources own. A configuration must not shadow one. */
export const RESERVED_CONTEXT_SOURCE_IDS = ["linear", "repository"] as const;

const SOURCE_ID = /^[a-z0-9][a-z0-9._:-]*$/;

export class ContextSourceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextSourceConfigurationError";
  }
}

export const assertContextSourceId = (id: string): void => {
  if (!SOURCE_ID.test(id)) {
    throw new ContextSourceConfigurationError(
      `The context source identifier "${id}" must be lower case letters, digits, dot, colon, ` +
        "underscore, or hyphen, and must start with a letter or a digit.",
    );
  }
  if ((RESERVED_CONTEXT_SOURCE_IDS as readonly string[]).includes(id)) {
    throw new ContextSourceConfigurationError(
      `The context source identifier "${id}" is reserved for a built-in source.`,
    );
  }
};

/**
 * SDD section 18 forbids organization-wide unbounded retrieval by default, so every bound below
 * has a ceiling a configuration cannot raise.
 */
const backstageSettings = z
  .object({
    kind: z.literal("backstage").default("backstage"),
    /**
     * The catalog entity to start from, as `component:default/name`. When it is null the source
     * finds the entity of the primary repository instead.
     */
    primaryComponent: z.string().min(1).nullable().default(null),
    maxEntities: z.number().int().min(1).max(200).default(50),
    includeOwnership: z.boolean().default(true),
  })
  .strict();

const mcpSettings = z
  .object({
    kind: z.literal("mcp").default("mcp"),
    discoverTool: z.string().min(1),
    fetchTool: z.string().min(1),
    /**
     * SDD section 58. A tool call is denied unless this list names the tool. The two tools the
     * source calls are always added, because configuring a tool and forbidding it is a mistake,
     * not a policy.
     */
    allowedTools: z.array(z.string().min(1)).default([]),
    authority: z.enum(AUTHORITY_CLASSES as unknown as [string, ...string[]]).default(
      "prose_documentation",
    ),
    maxCandidates: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export type BackstageSourceSettings = z.infer<typeof backstageSettings>;

export interface McpSourceSettings {
  kind: "mcp";
  discoverTool: string;
  fetchTool: string;
  allowedTools: string[];
  authority: AuthorityClass;
  maxCandidates: number;
}

export type ContextSourceSettings = BackstageSourceSettings | McpSourceSettings;

const describeIssue = (issue: z.core.$ZodIssue): string => {
  const path = issue.path.length === 0 ? "settings" : issue.path.join(".");
  const keys = issue.code === "unrecognized_keys" ? ` (${issue.keys.join(", ")})` : "";
  return `${path}: ${issue.message}${keys}`;
};

/**
 * Validates the settings of one configuration row. SDD section 15 requires that an unknown key
 * fails validation, and the same rule is right here: a typo must never pass as a default.
 */
export const parseContextSourceSettings = (
  kind: ContextSourceKind,
  settings: unknown,
): ContextSourceSettings => {
  const schema = kind === "backstage" ? backstageSettings : mcpSettings;
  const parsed = schema.safeParse(settings ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map(describeIssue).join("; ");
    throw new ContextSourceConfigurationError(
      `The ${kind} context source settings are invalid: ${detail}`,
    );
  }
  if (parsed.data.kind === "backstage") return parsed.data;
  const data = parsed.data;
  return {
    kind: "mcp",
    discoverTool: data.discoverTool,
    fetchTool: data.fetchTool,
    allowedTools: [...new Set([...data.allowedTools, data.discoverTool, data.fetchTool])].sort(),
    authority: data.authority as AuthorityClass,
    maxCandidates: data.maxCandidates,
  };
};

export interface ContextSourceConfigurationRecord {
  id: string;
  tenantId: string;
  productId: string;
  /** The value `ContextSource.id()` returns for the built source. */
  sourceId: string;
  kind: ContextSourceKind;
  enabled: boolean;
  /** The base URL of the catalog or of the MCP server. */
  endpoint: string;
  /**
   * SDD section 30. A credential never lives in this row. The column names one `ProductSecret`
   * of the same Product, and the value is read at the moment the source is built.
   */
  secretName: string | null;
  settings: ContextSourceSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateContextSourceConfigurationInput {
  tenantId: string;
  productId: string;
  sourceId: string;
  kind: ContextSourceKind;
  endpoint: string;
  enabled?: boolean;
  secretName?: string | null;
  settings?: unknown;
}

/** SDD section 52. Every method filters on the tenant. */
export interface ContextSourceConfigurationStore {
  put(input: CreateContextSourceConfigurationInput): Promise<ContextSourceConfigurationRecord>;
  list(tenantId: string, productId: string): Promise<ContextSourceConfigurationRecord[]>;
  remove(tenantId: string, productId: string, sourceId: string): Promise<boolean>;
}
