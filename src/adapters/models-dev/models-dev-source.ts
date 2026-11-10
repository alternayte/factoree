import { MODELS_DEV_URL, type ModelCatalogSource } from "~/domain/products/model-catalog-service.js";
import type { RawCatalog } from "~/domain/products/model-catalog.js";

const FETCH_TIMEOUT_MS = 30_000;

/** Fetches the models.dev catalog with its ETag. A 304 means the stored copy is current. */
export const createModelsDevSource = (url: string = MODELS_DEV_URL): ModelCatalogSource => ({
  async fetch(etag) {
    const response = await fetch(url, {
      headers: { accept: "application/json", ...(etag === null ? {} : { "if-none-match": etag }) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 304) return { kind: "not-modified" };
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error(`${url} returned no catalog object`);
    return { kind: "fetched", etag: response.headers.get("etag"), data: data as RawCatalog };
  },
});
