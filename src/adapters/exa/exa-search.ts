import { readTextWithCap } from "~/adapters/http/capped-response-body.js";
import type { SearchHit, WebSearchPort } from "~/domain/retro/web-research.js";

/** The longest one Exa request may take. */
export const EXA_TIMEOUT_MS = 30_000;
const EXA_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SNIPPET_CHARS = 1_000;
const PAGE_CHARS = 200_000;

export class ExaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExaError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const stringOr = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/**
 * docs/specs/retro-web-research.md. Exa search and contents, read 2026-11-26
 * (https://exa.ai/docs/reference/search). The key goes in the x-api-key header and never into a
 * message. Exa fetches the page, so the worker and the API open no site.
 */
export class ExaSearch implements WebSearchPort {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://api.exa.ai",
  ) {}

  async search(query: string, limit: number): Promise<SearchHit[]> {
    const body = await this.post("/search", {
      query,
      numResults: limit,
      type: "auto",
      contents: { highlights: { numSentences: 3, highlightsPerUrl: 2 }, text: { maxCharacters: SNIPPET_CHARS } },
    });
    const results = isRecord(body) && Array.isArray(body["results"]) ? body["results"] : [];
    return results.filter(isRecord).flatMap((result) => {
      const url = stringOr(result["url"]);
      if (url === null) return [];
      const highlights = Array.isArray(result["highlights"]) ? result["highlights"].filter((entry): entry is string => typeof entry === "string") : [];
      const snippet = highlights.length > 0 ? highlights.join(" … ") : (stringOr(result["text"]) ?? "").slice(0, SNIPPET_CHARS);
      return [{ url, title: stringOr(result["title"]), publishedDate: stringOr(result["publishedDate"]), snippet }];
    });
  }

  async contents(url: string): Promise<{ title: string | null; text: string } | null> {
    const body = await this.post("/contents", { urls: [url], text: { maxCharacters: PAGE_CHARS } });
    const results = isRecord(body) && Array.isArray(body["results"]) ? body["results"].filter(isRecord) : [];
    const first = results[0];
    const text = first === undefined ? null : stringOr(first["text"]);
    return text === null ? null : { title: stringOr(first?.["title"]), text };
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(EXA_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ExaError(`Exa ${path} did not answer: ${error instanceof Error ? error.name : "error"}`);
    }
    const text = await readTextWithCap(response, EXA_MAX_RESPONSE_BYTES);
    if (text === null) throw new ExaError(`Exa ${path} answered with a body above ${EXA_MAX_RESPONSE_BYTES} bytes`);
    if (!response.ok) throw new ExaError(`Exa ${path} answered ${response.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ExaError(`Exa ${path} answered with a body that is not JSON`);
    }
  }
}
