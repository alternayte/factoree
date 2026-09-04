import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  FACTOREE_SECRET_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 32 bytes of hexadecimal"),
  ADMIN_API_TOKEN: z.string().min(32),
  LINEAR_WEBHOOK_SECRET: z.string().min(1),
  // The OAuth application of Factoree. Both values together let the worker refresh a Linear
  // access token, which lives for twenty-four hours. Without them an operator must store a new
  // token by hand each day.
  LINEAR_CLIENT_ID: z.string().min(1).optional(),
  LINEAR_CLIENT_SECRET: z.string().min(1).optional(),
  TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
  TEMPORAL_TASK_QUEUE: z.string().min(1).default("factoree"),
  TEMPORAL_API_KEY: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SPRITES_TOKEN: z.string().min(1).optional(),
  SPRITES_BASE_URL: z.string().url().optional(),
  SANDBOX_ADAPTER: z.enum(["fly-sprites", "local"]).default("fly-sprites"),
  SANDBOX_LOCAL_ROOT: z.string().min(1).default("/tmp/factoree-sandboxes"),
  EVIDENCE_STORAGE: z.enum(["filesystem", "linear"]).default("filesystem"),
  EVIDENCE_LOCAL_ROOT: z.string().min(1).default("/tmp/factoree-evidence"),
  GITHUB_BASE_URL: z.string().url().default("https://github.com"),
  GITHUB_API_BASE_URL: z.string().url().default("https://api.github.com"),
  FACTOREE_GIT_AUTHOR_NAME: z.string().min(1).default("Factoree"),
  FACTOREE_GIT_AUTHOR_EMAIL: z.string().email().default("factoree@users.noreply.github.com"),
  // SDD section 30. The App identity. Factoree signs a short JWT with the private key. It
  // exchanges that JWT for a token scoped to one installation. The token reads a repository
  // before Factoree knows which Product the repository names.
  GITHUB_APP_ID: z.string().min(1),
  // A PEM holds several lines. An environment file carries one line reliably, so the value is
  // base64. Factoree decodes it at load. Nothing reaches the filesystem.
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64 with no line break"),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
}).refine((value) => value.SANDBOX_ADAPTER !== "fly-sprites" || value.SPRITES_TOKEN !== undefined, {
  message: "SPRITES_TOKEN is required when SANDBOX_ADAPTER is fly-sprites",
  path: ["SPRITES_TOKEN"],
});

export type Env = z.infer<typeof schema>;

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => schema.parse(source);
