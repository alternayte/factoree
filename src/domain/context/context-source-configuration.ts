import { z } from "zod";
import { AUTHORITY_CLASSES, type AuthorityClass } from "./authority.js";

/**
 * SDD section 53 requires a `ContextSourceConfiguration` entity. SDD section 17 fixes the source
 * list of Version 1. Linear and the GitHub repositories are always present and need no row, so a
 * row configures a Backstage catalog, a generic MCP server, or an llms.txt file
 * (docs/specs/external-context-delivery.md).
 */
export const CONTEXT_SOURCE_KINDS = ["backstage", "mcp", "llms_txt"] as const;

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
export const backstageSettingsSchema = z
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

export const mcpSettingsSchema = z
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

/** docs/specs/external-context-delivery.md. The page caps a configuration can never raise past. */
export const LLMS_TXT_MAX_PAGES = 20;
export const LLMS_TXT_MAX_PAGE_BYTES = 1024 * 1024;

/**
 * docs/specs/external-context-delivery.md. An llms.txt source. The endpoint is the URL of the
 * llms.txt file itself. DI-5.11 gives prose documentation as the default authority.
 */
export const llmsTxtSettingsSchema = z
  .object({
    kind: z.literal("llms_txt").default("llms_txt"),
    authority: z.enum(AUTHORITY_CLASSES as unknown as [string, ...string[]]).default(
      "prose_documentation",
    ),
    maxPages: z.number().int().min(1).max(LLMS_TXT_MAX_PAGES).default(5),
    maxPageBytes: z.number().int().min(1).max(LLMS_TXT_MAX_PAGE_BYTES).default(256 * 1024),
  })
  .strict();

export type BackstageSourceSettings = z.infer<typeof backstageSettingsSchema>;

export interface LlmsTxtSourceSettings {
  kind: "llms_txt";
  authority: AuthorityClass;
  maxPages: number;
  maxPageBytes: number;
}

export interface McpSourceSettings {
  kind: "mcp";
  discoverTool: string;
  fetchTool: string;
  allowedTools: string[];
  authority: AuthorityClass;
  maxCandidates: number;
}

export type ContextSourceSettings = BackstageSourceSettings | McpSourceSettings | LlmsTxtSourceSettings;

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
  const schema =
    kind === "backstage" ? backstageSettingsSchema : kind === "mcp" ? mcpSettingsSchema : llmsTxtSettingsSchema;
  const parsed = schema.safeParse(settings ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map(describeIssue).join("; ");
    throw new ContextSourceConfigurationError(
      `The ${kind} context source settings are invalid: ${detail}`,
    );
  }
  if (parsed.data.kind === "backstage") return parsed.data;
  if (parsed.data.kind === "llms_txt") {
    return {
      kind: "llms_txt",
      authority: parsed.data.authority as AuthorityClass,
      maxPages: parsed.data.maxPages,
      maxPageBytes: parsed.data.maxPageBytes,
    };
  }
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

/**
 * The endpoint must be a URL an operator can repair now, not a fault inside a Run. SDD section 60:
 * a credential in the userinfo, the query or the fragment would reach a log line, an error message
 * and the Context Contract, so each is refused, and no message echoes the value.
 */
export const assertContextSourceEndpoint = (sourceId: string, endpoint: string): void => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ContextSourceConfigurationError(`The endpoint "${endpoint}" is not a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ContextSourceConfigurationError(
      `The endpoint of the context source "${sourceId}" must be an http or https URL.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ContextSourceConfigurationError(
      `The endpoint of the context source "${sourceId}" carries a user name or a ` +
        "password. Remove the credential from the URL, and name a Product secret instead.",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ContextSourceConfigurationError(
      `The endpoint of the context source "${sourceId}" carries a query string or a ` +
        "fragment. An endpoint is a base address, and a credential belongs in a Product secret.",
    );
  }
};

export interface ContextSourceConfigurationRecord {
  id: string;
  tenantId: string;
  productId: string;
  /** The value `ContextSource.id()` returns for the built source. */
  sourceId: string;
  kind: ContextSourceKind;
  enabled: boolean;
  /** The base URL of the catalog, the MCP server URL, or the URL of the llms.txt file. */
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
  /**
   * DI-15.18. For each source of the Product, the time of the newest Context Contract that holds
   * an item from it. A source with no such item is absent from the map.
   */
  lastReads(tenantId: string, productId: string): Promise<Map<string, Date>>;
}
