import { z } from "zod";
import { SANDBOX_PROVIDERS, type InstallSettings } from "~/domain/settings/install-settings.js";
import { buildInfo } from "~/config/build-info.js";

/**
 * docs/specs/release-0-1-0.md. The shapes of the settings API. The zod schemas validate the
 * requests, and `schemaOf` turns each one into the JSON Schema of the OpenAPI document.
 */

const autonomyLevel = z.enum(["L0", "L1", "L2", "L3"]);

export const effortSchema = z.object({
  implementer: z.string().nullable(),
  refiner: z.string().nullable(),
  validator: z.string().nullable(),
  reviewer: z.string().nullable(),
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
  model: z.string().nullable(),
  effort: effortSchema,
  silenceMinutes: z.number(),
  sandboxRetentionHours: z.number(),
  maxConcurrentRuns: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const secretDescriptorSchema = z.object({
  name: z.string(),
  injectIntoImplementer: z.boolean(),
  kind: z.enum(["test", "runner_credential", "repository_read", "publish"]),
});

export const workspaceQuerySchema = z.object({ linearWorkspaceId: z.string().min(1) });

export const linearTeamSchema = z.object({ id: z.string(), key: z.string(), name: z.string() });

/** The Product settings of docs/specs/release-0-1-0.md, as `PUT /admin/products/:id` takes them. */
export const productSettingsFields = {
  model: z
    .string()
    .regex(/^[^\s/]+\/\S+$/, "must name a model as provider/model")
    .nullable(),
  effort: z
    .object({
      implementer: z.string().min(1).nullable(),
      refiner: z.string().min(1).nullable(),
      validator: z.string().min(1).nullable(),
      reviewer: z.string().min(1).nullable(),
    })
    .partial()
    .strict(),
  silenceMinutes: z.number().int().positive().max(240),
  sandboxRetentionHours: z.number().int().min(0).max(24 * 30),
  maxConcurrentRuns: z.number().int().positive().max(100),
};

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
    sandbox: z
      .object({
        provider: z.enum(SANDBOX_PROVIDERS),
        url: z.string().url().nullable(),
        apiKey: z.string().min(1),
        image: z.string().regex(IMAGE_BY_DIGEST, "must name the image by digest, as <name>@sha256:<hex>").nullable(),
        registryUsername: z.string().min(1).nullable(),
        registryToken: z.string().min(1).nullable(),
        maxLive: z.number().int().positive().nullable(),
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
    provider: z.enum(SANDBOX_PROVIDERS).nullable(),
    url: z.string().nullable(),
    apiKeySet: z.boolean(),
    image: z.string().nullable(),
    pinnedImage: z.string().nullable(),
    registryUsername: z.string().nullable(),
    registryTokenSet: z.boolean(),
    maxLive: z.number().nullable(),
    localAllowed: z.boolean(),
  }),
  gitAuthor: z.object({ name: z.string(), email: z.string() }),
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
    provider: settings.sandbox.provider,
    url: settings.sandbox.url,
    apiKeySet: settings.sandbox.apiKey !== null,
    image: settings.sandbox.image,
    pinnedImage: buildInfo.sandboxImageDefault,
    registryUsername: settings.sandbox.registryUsername,
    registryTokenSet: settings.sandbox.registryToken !== null,
    maxLive: settings.sandbox.maxLive,
    localAllowed,
  },
  gitAuthor: settings.gitAuthor,
});

/** A sandbox provider must carry what its adapter needs before a Run can use it. */
export const sandboxSettingsProblem = (sandbox: InstallSettings["sandbox"], localAllowed: boolean): string | null => {
  switch (sandbox.provider) {
    case null:
      return null;
    case "local":
      return localAllowed ? null : "the local sandbox isolates nothing; set FACTOREE_UNSAFE_LOCAL_SANDBOX=1 on a development machine to allow it";
    case "kiln":
      if (sandbox.url === null) return "Kiln needs its URL";
      if (sandbox.apiKey === null) return "Kiln needs an API key";
      if (sandbox.image === null && buildInfo.sandboxImageDefault === null) return "this build pins no sandbox image, so Kiln needs an image";
      break;
    case "fly-sprites":
      if (sandbox.apiKey === null) return "Fly Sprites needs a token";
      break;
  }
  if ((sandbox.registryUsername === null) !== (sandbox.registryToken === null)) {
    return "the registry username and token go together";
  }
  return null;
};

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
