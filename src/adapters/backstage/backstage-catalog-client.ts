/**
 * SDD section 19. The Backstage Catalog is a topology source. This client reads it over the
 * Backstage Catalog HTTP API. SDD section 14 keeps a provider client in `src/adapters`, so
 * nothing in `src/domain` imports this file except through the port below.
 */

/** The Backstage entity fields SDD section 19 names, in the shape the source needs. */
export interface BackstageEntity {
  /** `kind:namespace/name`, lower case. This is the stable reference of SDD section 21. */
  ref: string;
  kind: string;
  namespace: string;
  name: string;
  title: string | null;
  description: string | null;
  /** An entity reference, or null. */
  owner: string | null;
  /** An entity reference, or null. */
  system: string | null;
  dependsOn: string[];
  providesApis: string[];
  consumesApis: string[];
  /** The `owner/repo` slug of the source location, when the annotation gives one. */
  repositorySlug: string | null;
  /** The repository URL of the source location, without the tree path. */
  repositoryUrl: string | null;
  /** `spec.definition` of an API entity. */
  definition: string | null;
  /** SDD section 21 requires a source version. The catalog etag is that version. */
  sourceVersion: string;
}

export interface BackstageCatalogPort {
  getByRef(ref: string): Promise<BackstageEntity | null>;
  findByRepositorySlug(slug: string): Promise<BackstageEntity | null>;
}

export class BackstageCatalogError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BackstageCatalogError";
  }
}

/** The longest one catalog request may take. A slow catalog must not hold a Run. */
export const BACKSTAGE_TIMEOUT_MS = 15_000;

/** SDD section 18. A filtered query never returns more than this. */
export const BACKSTAGE_QUERY_LIMIT = 5;

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/**
 * Backstage writes a relation target either as a full reference or as a bare name. A bare name
 * takes the default kind of the relation, which is how the catalog itself reads it.
 */
const normalizeRef = (value: string, defaultKind: string, namespace: string): string => {
  const lower = value.trim().toLowerCase();
  if (lower.includes(":")) return lower.includes("/") ? lower : lower.replace(":", `:${namespace}/`);
  return `${defaultKind}:${namespace}/${lower}`;
};

/**
 * `backstage.io/source-location` is written as `url:https://host/owner/repo/tree/<ref>/<path>`.
 * The slug is the first two path segments. Anything else yields null, and the caller then simply
 * has no repository for that entity.
 */
const sourceLocationOf = (
  annotations: Record<string, unknown>,
): { slug: string | null; url: string | null } => {
  const raw =
    asString(annotations["backstage.io/source-location"]) ??
    asString(annotations["backstage.io/managed-by-location"]);
  if (raw === null) return { slug: null, url: null };
  const withoutScheme = raw.startsWith("url:") ? raw.slice(4) : raw;
  let parsed: URL;
  try {
    parsed = new URL(withoutScheme);
  } catch {
    return { slug: null, url: null };
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  const owner = segments[0];
  const repository = segments[1];
  if (owner === undefined || repository === undefined) return { slug: null, url: null };
  const name = repository.replace(/\.git$/, "");
  return {
    slug: `${owner}/${name}`,
    url: `${parsed.protocol}//${parsed.host}/${owner}/${name}`,
  };
};

export const parseBackstageEntity = (document: unknown): BackstageEntity => {
  const entity = asRecord(document);
  const metadata = asRecord(entity["metadata"]);
  const spec = asRecord(entity["spec"]);
  const kind = asString(entity["kind"]);
  const name = asString(metadata["name"]);
  if (kind === null || name === null) {
    throw new BackstageCatalogError("the document is not a Backstage entity");
  }
  const namespace = asString(metadata["namespace"]) ?? "default";
  const sourceVersion = asString(metadata["etag"]) ?? asString(metadata["uid"]);
  if (sourceVersion === null) {
    // SDD section 21 requires a source version on every candidate. An entity without one cannot
    // be recorded with provenance, so it is not an entity Factoree can use.
    throw new BackstageCatalogError(`the entity "${kind}:${namespace}/${name}" has no version`);
  }
  const owner = asString(spec["owner"]);
  const system = asString(spec["system"]);
  const location = sourceLocationOf(asRecord(metadata["annotations"]));

  return {
    ref: `${kind.toLowerCase()}:${namespace}/${name}`,
    kind,
    namespace,
    name,
    title: asString(metadata["title"]),
    description: asString(metadata["description"]),
    owner: owner === null ? null : normalizeRef(owner, "group", namespace),
    system: system === null ? null : normalizeRef(system, "system", namespace),
    dependsOn: asStrings(spec["dependsOn"]).map((value) => normalizeRef(value, "component", namespace)),
    providesApis: asStrings(spec["providesApis"]).map((value) => normalizeRef(value, "api", namespace)),
    consumesApis: asStrings(spec["consumesApis"]).map((value) => normalizeRef(value, "api", namespace)),
    repositorySlug: location.slug,
    repositoryUrl: location.url,
    definition: asString(spec["definition"]),
    sourceVersion,
  };
};

export interface BackstageCatalogClientOptions {
  endpoint: string;
  /** SDD section 30. A static Backstage token, or null for an unauthenticated catalog. */
  token: string | null;
  fetch?: typeof fetch;
}

export class BackstageCatalogClient implements BackstageCatalogPort {
  private readonly endpoint: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: BackstageCatalogClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.fetch = options.fetch ?? fetch;
  }

  private async request(path: string): Promise<unknown> {
    const url = `${this.endpoint}${path}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.options.token !== null) headers["Authorization"] = `Bearer ${this.options.token}`;

    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(BACKSTAGE_TIMEOUT_MS),
      });
    } catch (error) {
      // SDD section 60. The message names the URL and never the header.
      throw new BackstageCatalogError(`the Backstage request to ${url} failed`, { cause: error });
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new BackstageCatalogError(
        `the Backstage request to ${url} answered ${response.status}`,
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new BackstageCatalogError(`the Backstage answer from ${url} is not JSON`, { cause: error });
    }
  }

  async getByRef(ref: string): Promise<BackstageEntity | null> {
    const match = /^([a-z0-9-]+):([^/]+)\/(.+)$/.exec(ref.trim().toLowerCase());
    if (match === null) return null;
    const [, kind, namespace, name] = match;
    const document = await this.request(
      `/api/catalog/entities/by-name/${encodeURIComponent(kind ?? "")}/${encodeURIComponent(namespace ?? "")}/${encodeURIComponent(name ?? "")}`,
    );
    return document === null ? null : parseBackstageEntity(document);
  }

  /**
   * SDD section 18 forbids unbounded retrieval. The query filters on the annotation and caps the
   * answer, so the catalog never streams its whole contents into Factoree. The filter carries
   * the annotation key so the catalog itself does the matching; the client then checks the exact
   * slug on the candidates the catalog returns.
   */
  async findByRepositorySlug(slug: string): Promise<BackstageEntity | null> {
    const parameters = new URLSearchParams();
    parameters.set("filter", "kind=component,metadata.annotations.backstage.io/source-location");
    parameters.set("limit", String(BACKSTAGE_QUERY_LIMIT));
    parameters.set("fields", "kind,metadata,spec");
    const document = await this.request(`/api/catalog/entities/by-query?${parameters.toString()}`);
    const rawItems = asRecord(document)["items"];
    const items = Array.isArray(rawItems) ? rawItems : [];
    for (const item of items) {
      let entity: BackstageEntity;
      try {
        entity = parseBackstageEntity(item);
      } catch {
        continue;
      }
      if (entity.repositorySlug === slug) return entity;
    }
    return null;
  }
}
