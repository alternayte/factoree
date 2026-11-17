import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  basicOf,
  HOST_CREDENTIAL_KINDS,
  HOST_CREDENTIAL_SECRET_KIND,
  hostCredentialOf,
  hostCredentialSecretName,
  MAX_HOST_CREDENTIALS,
  SUGGESTED_REDIRECT_HOSTS,
  validateHostCredentials,
  type HostCredential,
  type HostCredentialInput,
  type HostCredentialStore,
} from "~/domain/products/host-credentials.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { BuildAheadTrigger } from "~/domain/runs/build-ahead.js";
import { errorSchema, schemaOf, SESSION_SECURITY, useSchemasAsDocumentation } from "../openapi.js";
import { workspaceQuerySchema } from "./schemas.js";

const TAGS = ["products"];
const idParams = schemaOf(z.object({ id: z.string() }));
const workspaceQuery = schemaOf(workspaceQuerySchema);

const credentialInputSchema = z
  .object({
    kind: z.enum(HOST_CREDENTIAL_KINDS),
    host: z.string(),
    username: z.string().nullable().optional(),
    headerName: z.string().nullable().optional(),
    pathPrefix: z.string().nullable().optional(),
    redirectHosts: z.array(z.string()).optional(),
    repositories: z.array(z.string()).optional(),
    /** Absent or null keeps the stored secret. */
    secret: z.string().nullable().optional(),
  })
  .strict();

const bodySchema = z.object({ credentials: z.array(credentialInputSchema).max(MAX_HOST_CREDENTIALS * 2) }).strict();

const credentialSchema = z.object({
  kind: z.enum(HOST_CREDENTIAL_KINDS),
  host: z.string(),
  username: z.string().nullable(),
  headerName: z.string().nullable(),
  pathPrefix: z.string().nullable(),
  realmHost: z.string().nullable(),
  redirectHosts: z.array(z.string()),
  repositories: z.array(z.string()),
  /** True when a secret is stored. A value never leaves the store. */
  hasSecret: z.boolean(),
});

const listSchema = z.object({
  credentials: z.array(credentialSchema),
  /** The redirect hosts the form suggests per GitHub Packages host. The operator confirms them. */
  suggestedRedirectHosts: z.record(z.string(), z.array(z.string())),
});

/** The Basic form a registry provider sends, stored so the redactor holds it (docs/specs/host-credentials.md). */
const basicSecretName = (host: string): string => `${hostCredentialSecretName(host)}:basic`;

export interface HostCredentialRouteDependencies {
  products: ProductRegistry;
  tenants: TenantRegistry;
  secrets: SecretStore;
  credentials: HostCredentialStore;
  /** Checks a registry login and finds its token service. Throws with the registry's answer. */
  checkRegistryLogin: (host: string, username: string, secret: string) => Promise<{ realmHost: string | null; realmPath: string | null }>;
  /** The GitHub App installations of a tenant. */
  installations: (tenantId: string) => Promise<string[]>;
  listInstallationRepositories: (installationId: string) => Promise<Array<{ fullName: string }>>;
  buildAhead?: Pick<BuildAheadTrigger, "afterAllowListChange"> | undefined;
}

class CheckError extends Error {}

/**
 * docs/specs/host-credentials.md. The host credentials of one product. A save checks everything
 * before it writes, so a failed check answers 422 and the product keeps its old list (DI-17.06).
 */
export const registerHostCredentialRoutes = (app: FastifyInstance, dependencies: HostCredentialRouteDependencies): void => {
  useSchemasAsDocumentation(app);

  const view = async (tenantId: string, productId: string): Promise<z.infer<typeof listSchema>> => {
    const credentials = await dependencies.credentials.list(tenantId, productId);
    const names = new Set(await dependencies.secrets.listNames(tenantId, productId));
    return {
      credentials: credentials.map((credential) => ({
        kind: credential.kind,
        host: credential.host,
        username: credential.username,
        headerName: credential.headerName,
        pathPrefix: credential.pathPrefix,
        realmHost: credential.realmHost,
        redirectHosts: credential.redirectHosts,
        repositories: credential.repositories,
        hasSecret: credential.kind !== "github" && names.has(hostCredentialSecretName(credential.host)),
      })),
      suggestedRedirectHosts: Object.fromEntries(Object.entries(SUGGESTED_REDIRECT_HOSTS).map(([host, hosts]) => [host, [...hosts]])),
    };
  };

  /** The one installation that sees every listed repository. */
  const installationFor = async (tenantId: string, repositories: readonly string[]): Promise<string> => {
    const wanted = repositories.map((name) => name.toLowerCase());
    const missing = new Set(wanted);
    for (const installation of await dependencies.installations(tenantId)) {
      const seen = new Set((await dependencies.listInstallationRepositories(installation)).map((repository) => repository.fullName.toLowerCase()));
      for (const name of wanted) if (seen.has(name)) missing.delete(name);
      if (wanted.every((name) => seen.has(name))) return installation;
    }
    if (missing.size > 0) {
      throw new CheckError(`The GitHub App installation does not grant ${[...missing].sort().join(", ")}. Install the App on each repository first.`);
    }
    throw new CheckError("The listed repositories belong to different GitHub App installations. List repositories of one installation.");
  };

  app.get<{ Params: { id: string } }>(
    "/admin/products/:id/host-credentials",
    {
      schema: {
        tags: TAGS,
        operationId: "listHostCredentials",
        security: SESSION_SECURITY,
        params: idParams,
        querystring: workspaceQuery,
        response: { 200: schemaOf(listSchema), 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const query = workspaceQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: "invalid request" });
      const tenant = await dependencies.tenants.findByWorkspace(query.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const product = await dependencies.products.findById(tenant.id, request.params.id);
      if (!product) return reply.code(404).send({ error: "product not found" });
      return view(tenant.id, product.id);
    },
  );

  app.put<{ Params: { id: string } }>(
    "/admin/products/:id/host-credentials",
    {
      schema: {
        tags: TAGS,
        operationId: "putHostCredentials",
        security: SESSION_SECURITY,
        params: idParams,
        querystring: workspaceQuery,
        body: schemaOf(bodySchema),
        response: { 200: schemaOf(listSchema), 400: errorSchema, 404: errorSchema, 422: errorSchema },
      },
    },
    async (request, reply) => {
      const query = workspaceQuerySchema.safeParse(request.query);
      const body = bodySchema.safeParse(request.body);
      if (!query.success || !body.success) return reply.code(400).send({ error: "invalid request" });
      const tenant = await dependencies.tenants.findByWorkspace(query.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const product = await dependencies.products.findById(tenant.id, request.params.id);
      if (!product) return reply.code(404).send({ error: "product not found" });

      const inputs: HostCredentialInput[] = body.data.credentials.map((input) => ({
        kind: input.kind,
        host: input.host,
        ...(input.username === undefined ? {} : { username: input.username }),
        ...(input.headerName === undefined ? {} : { headerName: input.headerName }),
        ...(input.pathPrefix === undefined ? {} : { pathPrefix: input.pathPrefix }),
        ...(input.redirectHosts === undefined ? {} : { redirectHosts: input.redirectHosts }),
        ...(input.repositories === undefined ? {} : { repositories: input.repositories }),
        ...(input.secret === undefined ? {} : { secret: input.secret }),
      }));
      const previous = await dependencies.credentials.list(tenant.id, product.id);
      const names = new Set(await dependencies.secrets.listNames(tenant.id, product.id));
      const stored = new Set(previous.filter((credential) => names.has(hostCredentialSecretName(credential.host))).map((credential) => credential.host));
      const problems = validateHostCredentials(inputs, stored);
      if (problems.length > 0) return reply.code(422).send({ error: problems.join(" ") });

      // Every check runs before the first write.
      const records: HostCredential[] = [];
      const secrets = new Map<string, string>();
      try {
        for (const input of inputs) {
          const record = hostCredentialOf(input);
          const entered = input.secret ?? null;
          const secret =
            record.kind === "github"
              ? null
              : entered !== null && entered !== ""
                ? entered
                : await dependencies.secrets.get(tenant.id, product.id, hostCredentialSecretName(record.host));
          if (record.kind === "registry") {
            if (secret === null) throw new CheckError(`The registry login for ${record.host} has no secret.`);
            try {
              const realm = await dependencies.checkRegistryLogin(record.host, record.username ?? "", secret);
              record.realmHost = realm.realmHost;
              record.realmPath = realm.realmPath;
            } catch (error) {
              throw new CheckError(`The registry login for ${record.host} failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          if (record.kind === "github") record.githubInstallationId = await installationFor(tenant.id, record.repositories);
          if (secret !== null) secrets.set(record.host, secret);
          records.push(record);
        }
      } catch (error) {
        if (error instanceof CheckError) return reply.code(422).send({ error: error.message });
        throw error;
      }

      for (const record of records) {
        const secret = secrets.get(record.host);
        if (secret === undefined) continue;
        await dependencies.secrets.put(tenant.id, product.id, hostCredentialSecretName(record.host), secret, { kind: HOST_CREDENTIAL_SECRET_KIND });
        if (record.kind === "registry") {
          await dependencies.secrets.put(tenant.id, product.id, basicSecretName(record.host), basicOf(record.username ?? "", secret), { kind: HOST_CREDENTIAL_SECRET_KIND });
        }
      }
      await dependencies.credentials.replace(tenant.id, product.id, records);
      const kept = new Map(records.map((record) => [record.host, record.kind]));
      for (const credential of previous) {
        const kind = kept.get(credential.host);
        if (kind === undefined || kind === "github") await dependencies.secrets.remove(tenant.id, product.id, hostCredentialSecretName(credential.host));
        if (kind !== "registry") await dependencies.secrets.remove(tenant.id, product.id, basicSecretName(credential.host));
      }
      // The credential hosts are part of the bootstrap key of each repository.
      await dependencies.buildAhead?.afterAllowListChange(tenant.id, product.id);
      return view(tenant.id, product.id);
    },
  );
};
