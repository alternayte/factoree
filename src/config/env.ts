import { z } from "zod";

// A value made of one repeated character, or a value that still says "change-me", is the
// placeholder of `.env.example`. A copied example file must not boot with a public key.
const isPlaceholder = (value: string): boolean =>
  new Set(value.toLowerCase()).size === 1 || /change-me/i.test(value);

/**
 * docs/specs/release-0-1-0.md. The environment holds infrastructure only, every name with the
 * `FACTOREE_` prefix. The GitHub App, the Linear app, the sandbox provider, the git author and
 * every Product setting live in the database, and no setting there has a fallback here.
 */
const schema = z
  .object({
    FACTOREE_DATABASE_URL: z.string().min(1),
    // AES-256-GCM key of every stored credential, and the root of the session secret.
    FACTOREE_MASTER_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "must be 32 bytes of hexadecimal")
      .refine((value) => !isPlaceholder(value), "is the placeholder of .env.example. Generate a random key"),
    FACTOREE_TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
    FACTOREE_TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
    FACTOREE_TEMPORAL_TASK_QUEUE: z.string().min(1).default("factoree"),
    FACTOREE_TEMPORAL_API_KEY: z.string().min(1).optional(),
    // The URL a browser, GitHub and Linear reach the API at. Webhook and callback URLs derive from it.
    FACTOREE_PUBLIC_URL: z
      .string()
      .url()
      .transform((value) => value.replace(/\/+$/, "")),
    FACTOREE_PORT: z.coerce.number().int().positive().default(3000),
    // docs/specs/run-visibility.md. The Temporal UI inside the stack, for example
    // http://temporal-ui:8080. Unset means /temporal answers 404.
    FACTOREE_TEMPORAL_UI_URL: z.string().url().optional(),
    FACTOREE_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    // Test only. The local sandbox runs the agent as the worker user, and that user can read the
    // worker environment, which holds the master key. Only a developer machine may accept that,
    // and it must say so. Without this value the install settings refuse the local provider.
    FACTOREE_UNSAFE_LOCAL_SANDBOX: z.literal("1").optional(),
    FACTOREE_SANDBOX_LOCAL_ROOT: z.string().min(1).default("/tmp/factoree-sandboxes"),
    // Test only. "filesystem" keeps visual evidence on the worker disk instead of Linear.
    FACTOREE_EVIDENCE_STORAGE: z.enum(["filesystem", "linear"]).default("linear"),
    FACTOREE_EVIDENCE_LOCAL_ROOT: z.string().min(1).default("/tmp/factoree-evidence"),
  });

export type Env = z.infer<typeof schema>;

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => schema.parse(source);
