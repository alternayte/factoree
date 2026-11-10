import { safeUrlForMessage } from "~/domain/runs/checkout.js";
import { readTextWithCap } from "~/adapters/http/capped-response-body.js";

/**
 * docs/specs/external-context-delivery.md. Reads the llms.txt file of one documentation site and
 * the pages it links. SDD section 60 keeps the bearer token out of every message, so no message
 * built here names it.
 */
export interface LlmsTxtPort {
  /**
   * Reads one URL on the host of the endpoint. Answers null when the body passes `maxBytes`. A URL
   * on another host, and a redirect to another host, is an `LlmsTxtError`.
   */
  read(url: string, maxBytes: number): Promise<string | null>;
}

export class LlmsTxtError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmsTxtError";
  }
}

/** The longest one page read may take, the same bound as an MCP request. */
export const LLMS_TXT_TIMEOUT_MS = 15_000;

/** DI-21.36. A site may redirect a page a few times, for example to add a trailing slash. */
export const LLMS_TXT_MAX_REDIRECTS = 5;

export interface LlmsTxtClientOptions {
  /** The URL of the llms.txt file. Its host is the only host the client reads. */
  endpoint: string;
  /** The bearer token, or null when the site needs none. */
  token: string | null;
  fetch?: typeof fetch;
}

export class LlmsTxtClient implements LlmsTxtPort {
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: LlmsTxtClientOptions) {
    this.host = new URL(options.endpoint).host;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async read(url: string, maxBytes: number): Promise<string | null> {
    // One deadline covers every redirect and the whole body, so a slow site cannot hold a run.
    const signal = AbortSignal.timeout(LLMS_TXT_TIMEOUT_MS);
    let current = this.onHost(url);
    for (let redirects = 0; ; redirects += 1) {
      const safeUrl = safeUrlForMessage(current.href);
      const headers: Record<string, string> = { Accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" };
      if (this.options.token !== null) headers["Authorization"] = `Bearer ${this.options.token}`;
      let response: Response;
      try {
        // The worker has no egress policy, and an operator chose one host. A redirect is followed
        // here, by hand, only when it stays on that host.
        response = await this.fetchImpl(current.href, { headers, redirect: "manual", signal });
      } catch (cause) {
        throw new LlmsTxtError(`the request to ${safeUrl} failed`, { cause });
      }

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (location === null) throw new LlmsTxtError(`${safeUrl} answered ${response.status} with no location`);
        if (redirects >= LLMS_TXT_MAX_REDIRECTS) {
          throw new LlmsTxtError(`${safeUrl} redirected more than ${LLMS_TXT_MAX_REDIRECTS} times`);
        }
        current = this.onHost(new URL(location, current).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new LlmsTxtError(`${safeUrl} answered ${response.status}`);
      }
      try {
        return await readTextWithCap(response, maxBytes);
      } catch (cause) {
        throw new LlmsTxtError(`the answer from ${safeUrl} could not be read`, { cause });
      }
    }
  }

  private onHost(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new LlmsTxtError("a link is not a valid URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new LlmsTxtError(`${safeUrlForMessage(url)} is not an http or https URL`);
    }
    if (parsed.host !== this.host) {
      throw new LlmsTxtError(
        `${safeUrlForMessage(url)} is not on ${this.host}, the host of the llms.txt file, so Factoree does not read it`,
      );
    }
    return parsed;
  }
}
