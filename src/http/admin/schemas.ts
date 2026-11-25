import { z } from "zod";
import { PROJECT_SECRET_KINDS } from "~/domain/products/secret-store.js";
import { DEFAULT_KILN_SANDBOX_SIZE, SANDBOX_PROVIDERS, type InstallSettings } from "~/domain/settings/install-settings.js";
import type { SandboxProviderSettings } from "~/domain/settings/sandbox-providers.js";
import { buildInfo } from "~/config/build-info.js";
import { completeBucket, effectiveBucket, lockedBucketFields } from "~/domain/retro/transcript.js";

/** The `FACTOREE_TRANSCRIPT_S3_*` env vars, each of which wins over its install setting. */
export type TranscriptBucketEnv = Parameters<typeof lockedBucketFields>[0];
import { AGENT_RUNNERS } from "~/domain/products/agent-settings.js";
import { REFINER_CRITERIA_LIMIT_MAX, REFINER_CRITERIA_LIMIT_MIN } from "~/domain/refinement/refiner-proposal.js";
import { REPAIR_MAX_ATTEMPTS_MAX } from "~/domain/runs/repair-budget.js";
import {
  AUTOMATIC_FOLLOW_UP_LIMIT_MAX,
  AUTOMATIC_FOLLOW_UP_LIMIT_MIN,
  GITHUB_APP_SLUG,
  PRODUCT_GOAL_MAX_BYTES,
  RETRO_RETENTION_DAYS_MAX,
  RETRO_RETENTION_DAYS_MIN,
} from "~/domain/products/product-registry.js";

/**
 * docs/specs/release-0-1-0.md. The shapes of the settings API. The zod schemas validate the
 * requests, and `schemaOf` turns each one into the JSON Schema of the OpenAPI document.
 */

// docs/specs/pr-review-merge-and-deploy.md. L4 turns on GitHub auto-merge. Risk caps and the
// factoree:l0 to factoree:l2 labels still lower it.
const autonomyLevel = z.enum(["L0", "L1", "L2", "L3", "L4"]);

export const effortSchema = z.object({
  implementer: z.string().nullable(),
  refiner: z.string().nullable(),
  validator: z.string().nullable(),
  reviewer: z.string().nullable(),
  setup: z.string().nullable(),
});

const agentRunner = z.enum(AGENT_RUNNERS);

/** docs/specs/claude-code-runner.md. The runner of each role, or null for the default runner. */
export const roleRunnersSchema = z.object({
  implementer: agentRunner.nullable(),
  refiner: agentRunner.nullable(),
  validator: agentRunner.nullable(),
  reviewer: agentRunner.nullable(),
  setup: agentRunner.nullable(),
});

export const productSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(["pending", "active"]),
  linearTeamKey: z.string(),
  linearTeamId: z.string(),
  defaultAutonomy: z.string(),
  riskCaps: z.record(z.string(), z.string()).nullable(),
  allowedDomains: z.array(z.string()),
  maxRunMinutes: z.number(),
  organizationSkillsRepository: z.string().nullable(),
  /** docs/specs/skill-registry.md. A null set means every released skill. */
  skillRegistry: z.object({ kind: z.enum(["skael"]), url: z.string(), set: z.string().nullable() }).nullable(),
  /** docs/specs/skill-registry.md. Set by a save that changed the registry, when a run would drop skills. */
  skillRegistryWarning: z.string().nullable().optional(),
  defaultRunner: agentRunner,
  model: z.string().nullable(),
  runners: roleRunnersSchema,
  /** The model of each role, or null for the default model. */
  models: effortSchema,
  effort: effortSchema,
  silenceMinutes: z.number(),
  /** Issue #39. The most criteria a refiner proposal may hold. */
  refinerCriteriaLimit: z.number(),
  /** Issue #43. The repair budget of a run whose repository sets none. */
  repairMaxAttempts: z.number(),
  sandboxRetentionHours: z.number(),
  /** docs/specs/sandbox-provider-spillover.md. The sandbox providers the runs may use. Empty allows all. */
  sandboxProviderIds: z.array(z.string()),
  maxConcurrentRuns: z.number(),
  /** docs/specs/setup-app-change-issues.md. How many app-change issues a merged setup creates. */
  appChangeIssues: z.enum(["one_per_change", "one_for_all"]),
  /** docs/specs/pr-feedback-loop.md. The review app slugs whose findings Factoree does not act on. */
  reviewAppDenyList: z.array(z.string()),
  /** docs/specs/pr-feedback-loop.md. The most PR follow-up runs that review apps and CI checks start on one pull request. */
  automaticFollowUpLimit: z.number(),
  /** docs/specs/retro-agent.md. The product goal in markdown, which only the retro agent reads. */
  productGoal: z.string().nullable(),
  /** docs/specs/retro-agent.md. Keep the redacted transcript of every agent session. */
  keepTranscripts: z.boolean(),
  /** docs/specs/retro-agent.md. The days kept transcripts and signal results stay. */
  retroRetentionDays: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** docs/specs/repository-membership.md. The products list only: the claims no admin decided yet. */
  pendingRepositories: z.number().optional(),
});

export const secretDescriptorSchema = z.object({
  name: z.string(),
  injectIntoImplementer: z.boolean(),
  kind: z.enum(PROJECT_SECRET_KINDS),
});

export const workspaceQuerySchema = z.object({ linearWorkspaceId: z.string().min(1) });

export const linearTeamSchema = z.object({ id: z.string(), key: z.string(), name: z.string() });

/** The Product settings of docs/specs/release-0-1-0.md, as `PUT /admin/products/:id` takes them. */
export const productSettingsFields = {
  // docs/specs/claude-code-runner.md. The save checks each model against the runner it resolves to.
  defaultRunner: agentRunner,
  model: z.string().trim().min(1).nullable(),
  runners: z
    .object({
      implementer: agentRunner.nullable(),
      refiner: agentRunner.nullable(),
      validator: agentRunner.nullable(),
      reviewer: agentRunner.nullable(),
      setup: agentRunner.nullable(),
    })
    .partial()
    .strict(),
  models: z
    .object({
      implementer: z.string().trim().min(1).nullable(),
      refiner: z.string().trim().min(1).nullable(),
      validator: z.string().trim().min(1).nullable(),
      reviewer: z.string().trim().min(1).nullable(),
      setup: z.string().trim().min(1).nullable(),
    })
    .partial()
    .strict(),
  effort: z
    .object({
      implementer: z.string().min(1).nullable(),
      refiner: z.string().min(1).nullable(),
      validator: z.string().min(1).nullable(),
      reviewer: z.string().min(1).nullable(),
      setup: z.string().min(1).nullable(),
    })
    .partial()
    .strict(),
  silenceMinutes: z.number().int().positive().max(240),
  // Issue #39, DI-21.66. The criteria cap of the refiner proposal.
  refinerCriteriaLimit: z.number().int().min(REFINER_CRITERIA_LIMIT_MIN).max(REFINER_CRITERIA_LIMIT_MAX),
  // Issue #43, DI-21.67. The same bounds as `repair.maxAttempts` in .factoree/config.yaml.
  repairMaxAttempts: z.number().int().min(0).max(REPAIR_MAX_ATTEMPTS_MAX),
  sandboxRetentionHours: z.number().int().min(0).max(24 * 30),
  sandboxProviderIds: z.array(z.string().min(1)).max(50),
  maxConcurrentRuns: z.number().int().positive().max(100),
  appChangeIssues: z.enum(["one_per_change", "one_for_all"]),
  // docs/specs/pr-feedback-loop.md, DI-21.203. GitHub App slugs, stored in lower case, each once.
  reviewAppDenyList: z
    .array(
      z
        .string()
        .trim()
        .regex(GITHUB_APP_SLUG, "must be a GitHub App slug")
        .transform((slug) => slug.toLowerCase()),
    )
    .max(50)
    .transform((slugs) => [...new Set(slugs)].sort()),
  automaticFollowUpLimit: z.number().int().min(AUTOMATIC_FOLLOW_UP_LIMIT_MIN).max(AUTOMATIC_FOLLOW_UP_LIMIT_MAX),
  // docs/specs/retro-agent.md. An empty goal clears it.
  productGoal: z
    .string()
    .refine((goal) => Buffer.byteLength(goal, "utf8") <= PRODUCT_GOAL_MAX_BYTES, `must be at most ${PRODUCT_GOAL_MAX_BYTES / 1024} KiB`)
    .transform((goal) => (goal.trim() === "" ? null : goal))
    .nullable(),
  keepTranscripts: z.boolean(),
  retroRetentionDays: z.number().int().min(RETRO_RETENTION_DAYS_MIN).max(RETRO_RETENTION_DAYS_MAX),
};

/** docs/specs/pr-review-merge-and-deploy.md. What each GitHub App installation of a product lacks. */
export const githubAccessSchema = z.object({
  installations: z.array(
    z.object({
      installationId: z.string(),
      accountLogin: z.string().nullable(),
      /** The installation settings page, where an owner accepts new permissions. */
      settingsUrl: z.string().nullable(),
      repositories: z.array(z.string()),
      missingPermissions: z.array(z.object({ name: z.string(), required: z.string(), granted: z.string().nullable() })),
      missingEvents: z.array(z.string()),
      /** Set when Factoree could not read the installation. */
      error: z.string().nullable(),
    }),
  ),
});

/**
 * docs/specs/pr-review-merge-and-deploy.md, D5. The open L4 pull requests of a product that stay
 * open as at L3, each with the settings its repository misses.
 */
export const autoMergeAttentionSchema = z.object({
  pullRequests: z.array(
    z.object({
      repositoryFullName: z.string(),
      number: z.number(),
      url: z.string(),
      baseBranch: z.string(),
      /** One sentence for each missing setting. */
      reason: z.string(),
    }),
  ),
});

export { autonomyLevel };

const IMAGE_BY_DIGEST = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

export const installSettingsUpdateSchema = z
  .object({
    github: z
      .object({
        baseUrl: z.string().url(),
        apiBaseUrl: z.string().url(),
      })
      .partial()
      .strict(),
    linear: z
      .object({
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
        webhookSecret: z.string().min(1),
      })
      .partial()
      .strict(),
    // docs/specs/sandbox-provider-spillover.md. The image serves every sandbox provider. The
    // providers have their own routes.
    sandbox: z
      .object({
        image: z.string().regex(IMAGE_BY_DIGEST, "must name the image by digest, as <name>@sha256:<hex>").nullable(),
        registryUsername: z.string().min(1).nullable(),
        registryToken: z.string().min(1).nullable(),
      })
      .partial()
      .strict(),
    gitAuthor: z
      .object({
        name: z.string().min(1),
        email: z.string().email(),
      })
      .partial()
      .strict(),
    // docs/specs/retro-agent.md. The bucket of kept transcripts. Null clears a field.
    transcriptBucket: z
      .object({
        endpoint: z.string().url().nullable(),
        bucket: z.string().min(1).nullable(),
        region: z.string().min(1).nullable(),
        accessKey: z.string().min(1).nullable(),
        secretKey: z.string().min(1).nullable(),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();

export type InstallSettingsUpdate = z.infer<typeof installSettingsUpdateSchema>;

export const installSettingsViewSchema = z.object({
  publicUrl: z.string(),
  github: z.object({
    appId: z.string().nullable(),
    appSlug: z.string().nullable(),
    clientId: z.string().nullable(),
    privateKeySet: z.boolean(),
    webhookSecretSet: z.boolean(),
    baseUrl: z.string(),
    apiBaseUrl: z.string(),
    webhookUrl: z.string(),
    installUrl: z.string().nullable(),
  }),
  linear: z.object({
    clientId: z.string().nullable(),
    clientSecretSet: z.boolean(),
    webhookSecretSet: z.boolean(),
    webhookUrl: z.string(),
    installCallbackUrl: z.string(),
    signInCallbackUrl: z.string(),
  }),
  sandbox: z.object({
    image: z.string().nullable(),
    pinnedImage: z.string().nullable(),
    registryUsername: z.string().nullable(),
    registryTokenSet: z.boolean(),
    defaultSize: z.object({ vcpus: z.number(), memoryMb: z.number() }),
    localAllowed: z.boolean(),
  }),
  gitAuthor: z.object({ name: z.string(), email: z.string() }),
  /** docs/specs/retro-agent.md. The effective bucket of kept transcripts, and the fields an env var locks. */
  transcriptBucket: z.object({
    endpoint: z.string().nullable(),
    bucket: z.string().nullable(),
    region: z.string().nullable(),
    accessKey: z.string().nullable(),
    secretKeySet: z.boolean(),
    locked: z.array(z.enum(["endpoint", "bucket", "region", "accessKey", "secretKey"])),
    /** True when new transcripts go to the bucket, false when they stay in Postgres. */
    active: z.boolean(),
  }),
});

export type InstallSettingsView = z.infer<typeof installSettingsViewSchema>;

/** The callback URLs an operator registers in the Linear OAuth app. */
export const linearInstallCallbackUrl = (publicUrl: string): string => `${publicUrl}/api/linear/callback`;
export const linearSignInCallbackUrl = (publicUrl: string): string => `${publicUrl}/api/auth/callback/linear`;

/** No credential value leaves the API. A view says whether one is stored. */
export const viewInstallSettings = (
  settings: InstallSettings,
  publicUrl: string,
  localAllowed: boolean,
  bucketEnv: TranscriptBucketEnv = {},
): InstallSettingsView => ({
  publicUrl,
  github: {
    appId: settings.github.appId,
    appSlug: settings.github.appSlug,
    clientId: settings.github.clientId,
    privateKeySet: settings.github.privateKey !== null,
    webhookSecretSet: settings.github.webhookSecret !== null,
    baseUrl: settings.github.baseUrl,
    apiBaseUrl: settings.github.apiBaseUrl,
    webhookUrl: `${publicUrl}/webhooks/github`,
    installUrl:
      settings.github.appSlug === null
        ? null
        : `${settings.github.baseUrl.replace(/\/+$/, "")}/apps/${settings.github.appSlug}/installations/new`,
  },
  linear: {
    clientId: settings.linear.clientId,
    clientSecretSet: settings.linear.clientSecret !== null,
    webhookSecretSet: settings.linear.webhookSecret !== null,
    webhookUrl: `${publicUrl}/webhooks/linear`,
    installCallbackUrl: linearInstallCallbackUrl(publicUrl),
    signInCallbackUrl: linearSignInCallbackUrl(publicUrl),
  },
  sandbox: {
    image: settings.sandbox.image,
    pinnedImage: buildInfo.sandboxImageDefault,
    registryUsername: settings.sandbox.registryUsername,
    registryTokenSet: settings.sandbox.registryToken !== null,
    defaultSize: DEFAULT_KILN_SANDBOX_SIZE,
    localAllowed,
  },
  gitAuthor: settings.gitAuthor,
  transcriptBucket: (() => {
    const bucket = effectiveBucket(settings.transcriptBucket, bucketEnv);
    return {
      endpoint: bucket.endpoint,
      bucket: bucket.bucket,
      region: bucket.region,
      accessKey: bucket.accessKey,
      secretKeySet: bucket.secretKey !== null,
      locked: lockedBucketFields(bucketEnv),
      active: completeBucket(bucket) !== null,
    };
  })(),
});

/** The registry login of the sandbox image is a pair. */
export const sandboxSettingsProblem = (sandbox: InstallSettings["sandbox"]): string | null =>
  (sandbox.registryUsername === null) !== (sandbox.registryToken === null) ? "the registry username and token go together" : null;

/**
 * docs/specs/sandbox-provider-spillover.md. A sandbox provider must carry what its adapter needs
 * before a run can use it. `image` is the install image override.
 */
export const sandboxProviderProblem = (
  provider: Pick<SandboxProviderSettings, "type" | "url" | "apiKey">,
  image: string | null,
  localAllowed: boolean,
): string | null => {
  switch (provider.type) {
    case "local":
      return localAllowed ? null : "the local sandbox isolates nothing; set FACTOREE_UNSAFE_LOCAL_SANDBOX=1 on a development machine to allow it";
    case "kiln":
      if (provider.url === null) return "Kiln needs its URL";
      if (provider.apiKey === null) return "Kiln needs an API key";
      if (image === null && buildInfo.sandboxImageDefault === null) return "this build pins no sandbox image, so Kiln needs an image";
      return null;
    case "e2b":
      if (provider.apiKey === null) return "E2B needs an API key";
      if (image === null && buildInfo.sandboxImageDefault === null) return "this build pins no sandbox image, so E2B needs an image";
      return null;
    case "fly-sprites":
      return provider.apiKey === null ? "Fly Sprites needs a token" : null;
  }
};

const sandboxProviderFields = {
  name: z.string().trim().min(1).max(60),
  type: z.enum(SANDBOX_PROVIDERS),
  url: z.string().url().nullable(),
  apiKey: z.string().min(1).nullable(),
  maxLive: z.number().int().positive().nullable(),
  // docs/specs/kiln-sandbox-size.md. Kiln accepts 1 to 32 vCPUs. npm ci needs 1024 MB. E2B accepts
  // 1 to 8 vCPUs and 8 GiB.
  vcpus: z.number().int().min(1).max(32).nullable(),
  memoryMb: z.number().int().min(1024).max(1_048_576).nullable(),
  // docs/specs/sandbox-memory-and-size.md. The memory budget of the live sandboxes, and the largest
  // sandbox a repository minimum may ask of this provider.
  memoryBudgetMb: z.number().int().min(1024).max(16_777_216).nullable(),
  maxVcpus: z.number().int().min(1).max(32).nullable(),
  maxMemoryMb: z.number().int().min(1024).max(1_048_576).nullable(),
  priority: z.number().int().min(1).max(100),
  enabled: z.boolean(),
};

export const sandboxProviderCreateSchema = z
  .object(sandboxProviderFields)
  .partial()
  .required({ name: true, type: true })
  .strict();

export const sandboxProviderUpdateSchema = z.object(sandboxProviderFields).partial().strict();

export const sandboxProviderViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(SANDBOX_PROVIDERS),
  url: z.string().nullable(),
  apiKeySet: z.boolean(),
  maxLive: z.number().nullable(),
  vcpus: z.number().nullable(),
  memoryMb: z.number().nullable(),
  memoryBudgetMb: z.number().nullable(),
  maxVcpus: z.number().nullable(),
  maxMemoryMb: z.number().nullable(),
  priority: z.number(),
  enabled: z.boolean(),
  /** Set while selection skips the provider after a failed create. */
  downUntil: z.string().nullable(),
  downReason: z.string().nullable(),
  /** The live leases: running sandboxes and held slots. */
  live: z.number(),
  /** What the provider lacks before a run can use it, or null. */
  problem: z.string().nullable(),
});

export type SandboxProviderView = z.infer<typeof sandboxProviderViewSchema>;

export const viewSandboxProvider = (
  provider: SandboxProviderSettings,
  live: number,
  problem: string | null,
  now: Date,
): SandboxProviderView => ({
  id: provider.id,
  name: provider.name,
  type: provider.type,
  url: provider.url,
  apiKeySet: provider.apiKey !== null,
  maxLive: provider.maxLive,
  vcpus: provider.vcpus,
  memoryMb: provider.memoryMb,
  memoryBudgetMb: provider.memoryBudgetMb,
  maxVcpus: provider.maxVcpus,
  maxMemoryMb: provider.maxMemoryMb,
  priority: provider.priority,
  enabled: provider.enabled,
  downUntil: provider.downUntil !== null && provider.downUntil > now ? provider.downUntil.toISOString() : null,
  downReason: provider.downUntil !== null && provider.downUntil > now ? provider.downReason : null,
  live,
  problem,
});

export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  start: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastRequest: z.string().nullable(),
});

export const membershipSchema = z.object({
  tenantId: z.string(),
  linearWorkspaceId: z.string(),
  workspaceName: z.string(),
  admin: z.boolean(),
});

export const meSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  apiKeyId: z.string().nullable(),
  memberships: z.array(membershipSchema),
  operatorAdmin: z.boolean(),
  /** The Temporal namespace of the install, for the links into the Temporal UI. */
  temporalNamespace: z.string(),
});

export const workspaceSchema = z.object({
  tenantId: z.string(),
  linearWorkspaceId: z.string(),
  name: z.string(),
  admin: z.boolean(),
  linearInstallation: z
    .object({ expiresAt: z.string().nullable(), refreshable: z.boolean(), scopes: z.array(z.string()) })
    .nullable(),
  githubInstallations: z.array(z.object({ githubInstallationId: z.string(), accountLogin: z.string() })),
  productCount: z.number(),
});
