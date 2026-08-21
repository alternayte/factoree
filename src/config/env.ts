import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  FACTOREE_SECRET_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 32 bytes of hexadecimal"),
  ADMIN_API_TOKEN: z.string().min(32),
  LINEAR_WEBHOOK_SECRET: z.string().min(1),
  TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
  TEMPORAL_TASK_QUEUE: z.string().min(1).default("factoree"),
  TEMPORAL_API_KEY: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => schema.parse(source);
