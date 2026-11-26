import { createHash } from "node:crypto";
import { z } from "zod";

/** docs/specs/retro-agent.md. A product's MCP server for production errors or for analytics. */
export const SIGNAL_SOURCE_KINDS = ["errors", "analytics"] as const;
export type SignalSourceKind = (typeof SIGNAL_SOURCE_KINDS)[number];

export const DEFAULT_QUERY_BYTES = 256 * 1024;
export const MAX_QUERY_BYTES = 1024 * 1024;
export const MAX_QUERIES = 10;

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const signalQuerySchema = z
  .object({
    name: z.string().regex(NAME, "use lower case letters, digits and dashes"),
    tool: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).default({}),
    maxBytes: z.number().int().min(1).max(MAX_QUERY_BYTES).default(DEFAULT_QUERY_BYTES),
  })
  .strict();
export type SignalQuery = z.infer<typeof signalQuerySchema>;

export const signalSourceInputSchema = z
  .object({
    name: z.string().regex(NAME, "use lower case letters, digits and dashes"),
    kind: z.enum(SIGNAL_SOURCE_KINDS),
    endpoint: z.string().url(),
    secretName: z.string().min(1).nullable(),
    enabled: z.boolean().default(true),
    queries: z
      .array(signalQuerySchema)
      .max(MAX_QUERIES)
      .refine((queries) => new Set(queries.map((query) => query.name)).size === queries.length, "each query needs its own name"),
  })
  .strict();
export type SignalSourceInput = z.infer<typeof signalSourceInputSchema>;

export interface SignalSourceRecord extends SignalSourceInput {
  id: string;
  tenantId: string;
  productId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The text an operator writes in an argument to mean the end time of the last successful retro. */
export const SINCE_PLACEHOLDER = "{since}";

/**
 * Replaces `{since}` in every string of the arguments with the ISO 8601 time. A retro with no
 * earlier successful retro reads from `fallback`, so the first retro reads a bounded window.
 */
export const renderSignalArguments = (value: unknown, since: Date): unknown => {
  if (typeof value === "string") return value.split(SINCE_PLACEHOLDER).join(since.toISOString());
  if (Array.isArray(value)) return value.map((entry) => renderSignalArguments(entry, since));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renderSignalArguments(entry, since)]));
  }
  return value;
};

/** The path of one signal result in the retro sandbox, relative to the export directory. */
export const signalResultPath = (sourceName: string, queryName: string): string => `signals/${sourceName}/${queryName}.md`;

export const sha256Of = (text: string): string => createHash("sha256").update(text).digest("hex");
