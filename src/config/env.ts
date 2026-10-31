import { z } from "zod";

// A value made of one repeated character, or a value that still says "change-me", is the
// placeholder of `.env.example`. A copied example file must not boot with a public key or token.
const isPlaceholder = (value: string): boolean =>
  new Set(value.toLowerCase()).size === 1 || /change-me/i.test(value);

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  FACTOREE_SECRET_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "must be 32 bytes of hexadecimal")
    .refine((value) => !isPlaceholder(value), "is the placeholder of .env.example. Generate a random key"),
  ADMIN_API_TOKEN: z
    .string()
    .min(32)
    .refine((value) => !isPlaceholder(value), "is the placeholder of .env.example. Generate a random token"),
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
  SANDBOX_ADAPTER: z.enum(["fly-sprites", "kiln", "local"]).default("fly-sprites"),
  // docs/specs/kiln-sandbox-provider.md. The Kiln host, a key of the Factoree tenant, and the
  // sandbox image by digest. The registry login is for a private image only.
  KILN_URL: z.string().url().optional(),
  KILN_API_KEY: z.string().min(1).optional(),
  KILN_IMAGE: z
    .string()
    .regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/, "must name the image by digest, as <name>@sha256:<hex>")
    .optional(),
  KILN_REGISTRY_USERNAME: z.string().min(1).optional(),
  KILN_REGISTRY_TOKEN: z.string().min(1).optional(),
  // The local sandbox runs the agent as the worker user. That user can read the worker
  // environment, which holds the App private key and the secret key. Only a developer machine
  // may accept that, and it must say so.
  FACTOREE_UNSAFE_LOCAL_SANDBOX: z.literal("1").optional(),
  SANDBOX_LOCAL_ROOT: z.string().min(1).default("/tmp/factoree-sandboxes"),
  EVIDENCE_STORAGE: z.enum(["filesystem", "linear"]).default("linear"),
  // B-3. The opencode model and its reasoning effort, for every Run of this install. Absent means
  // opencode's own default. The provider key is a runner_credential Product secret.
  OPENCODE_MODEL: z.string().min(1).optional(),
  OPENCODE_VARIANT: z.string().min(1).optional(),
  // DI-14.40. The effort of one role, over OPENCODE_VARIANT. The refiner runs on the validator runner.
  OPENCODE_VARIANT_IMPLEMENTER: z.string().min(1).optional(),
  OPENCODE_VARIANT_REFINER: z.string().min(1).optional(),
  OPENCODE_VARIANT_VALIDATOR: z.string().min(1).optional(),
  OPENCODE_VARIANT_REVIEWER: z.string().min(1).optional(),
  // docs/specs/agent-session-usage-and-hangs.md. The silence limit: an agent session that writes
  // no output for this many minutes is hung. At max effort a model thinks for minutes in silence.
  AGENT_SILENCE_MINUTES: z.coerce.number().positive().default(10),
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
}).refine(
  (value) =>
    value.SANDBOX_ADAPTER !== "kiln" ||
    (value.KILN_URL !== undefined && value.KILN_API_KEY !== undefined && value.KILN_IMAGE !== undefined),
  {
    message: "KILN_URL, KILN_API_KEY and KILN_IMAGE are required when SANDBOX_ADAPTER is kiln",
    path: ["KILN_IMAGE"],
  },
).refine((value) => (value.KILN_REGISTRY_USERNAME === undefined) === (value.KILN_REGISTRY_TOKEN === undefined), {
  message: "KILN_REGISTRY_USERNAME and KILN_REGISTRY_TOKEN go together",
  path: ["KILN_REGISTRY_TOKEN"],
}).refine((value) => value.SANDBOX_ADAPTER !== "local" || value.FACTOREE_UNSAFE_LOCAL_SANDBOX === "1", {
  message:
    "SANDBOX_ADAPTER=local isolates nothing. Set FACTOREE_UNSAFE_LOCAL_SANDBOX=1 to accept that on a development machine",
  path: ["FACTOREE_UNSAFE_LOCAL_SANDBOX"],
});

export type Env = z.infer<typeof schema>;

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => schema.parse(source);
