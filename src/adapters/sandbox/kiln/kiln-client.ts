/**
 * docs/specs/kiln-sandbox-provider.md. The Kiln control API, as far as the sandbox adapter needs it.
 * The routes and shapes follow `client/client.go` in alternayte/kiln v0.9.4.
 */

export interface KilnTemplateRequest {
  name: string;
  image: string;
  vcpus: number;
  memory_mb: number;
  disk_mb: number;
  setup: string[];
  egress_allow: string[];
  user: string;
  credential?: { username: string; token: string };
}

export interface KilnTemplate {
  name: string;
  image: string;
  image_digest?: string;
  state: "building" | "ready" | "failed";
  error?: string;
}

export interface KilnSandboxRequest {
  template: string;
  lifecycle: "ephemeral" | "persistent";
  idle_seconds: number;
  ttl_seconds?: number;
  metadata?: Record<string, string>;
}

export interface KilnSandbox {
  id: string;
  state: string;
  egress_allow: string[];
}

export interface KilnProcessRequest {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface KilnProcess {
  id: string;
  running: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  stdout_offset: number;
  stderr_offset: number;
  stdout_lost: number;
  stderr_lost: number;
  more: boolean;
}

/** The Kiln API refused a call. `status` is the HTTP status, `code` the stable error code. */
export class KilnApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`kiln: HTTP ${status}: ${code}: ${message}`);
    this.name = "KilnApiError";
  }
}

export const isKilnNotFound = (error: unknown): boolean => error instanceof KilnApiError && error.status === 404;
export const isKilnConflict = (error: unknown): boolean => error instanceof KilnApiError && error.status === 409;

export interface KilnClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

/** Each path segment is escaped alone, so a slash in a guest path stays a separator. */
const escapePath = (path: string): string =>
  path
    .replace(/^\/+/, "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

export class KilnClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: KilnClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetch = options.fetch ?? fetch;
  }

  template(name: string): Promise<KilnTemplate> {
    return this.json("GET", `/v1/templates/${encodeURIComponent(name)}`);
  }

  async createTemplate(request: KilnTemplateRequest): Promise<void> {
    await this.json("POST", "/v1/templates", request);
  }

  async deleteTemplate(name: string): Promise<void> {
    await this.json("DELETE", `/v1/templates/${encodeURIComponent(name)}`);
  }

  createSandbox(request: KilnSandboxRequest): Promise<KilnSandbox> {
    return this.json("POST", "/v1/sandboxes", request);
  }

  async deleteSandbox(id: string): Promise<void> {
    await this.json("DELETE", `/v1/sandboxes/${encodeURIComponent(id)}`);
  }

  setEgress(id: string, allow: string[]): Promise<KilnSandbox> {
    return this.json("PUT", `/v1/sandboxes/${encodeURIComponent(id)}/egress`, { egress_allow: allow });
  }

  async startProcess(id: string, request: KilnProcessRequest): Promise<string> {
    const created = await this.json<{ id: string }>("POST", `/v1/sandboxes/${encodeURIComponent(id)}/processes`, request);
    return created.id;
  }

  readProcess(id: string, pid: string, stdoutOffset: number, stderrOffset: number): Promise<KilnProcess> {
    const query = `stdout_offset=${stdoutOffset}&stderr_offset=${stderrOffset}`;
    return this.json("GET", `/v1/sandboxes/${encodeURIComponent(id)}/processes/${encodeURIComponent(pid)}?${query}`);
  }

  async signalProcess(id: string, pid: string, signal: "TERM" | "KILL"): Promise<void> {
    await this.json(
      "DELETE",
      `/v1/sandboxes/${encodeURIComponent(id)}/processes/${encodeURIComponent(pid)}?signal=${signal}`,
    );
  }

  async writeFile(id: string, path: string, content: string): Promise<void> {
    await this.request("PUT", `/v1/sandboxes/${encodeURIComponent(id)}/files/${escapePath(path)}`, content);
  }

  async snapshot(id: string): Promise<string> {
    const created = await this.json<{ snapshot_id: string }>(
      "POST",
      `/v1/sandboxes/${encodeURIComponent(id)}/snapshot`,
      { stop: false },
    );
    return created.snapshot_id;
  }

  async restoreSnapshot(snapshotId: string): Promise<KilnSandbox> {
    const copies = await this.json<{ sandboxes: KilnSandbox[] }>(
      "POST",
      `/v1/snapshots/${encodeURIComponent(snapshotId)}/restore`,
      { count: 1, allow_secret_fork: false },
    );
    const copy = copies.sandboxes[0];
    if (copy === undefined) throw new KilnApiError(500, "internal", "the restore returned no sandbox");
    return copy;
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    await this.json("DELETE", `/v1/snapshots/${encodeURIComponent(snapshotId)}`);
  }

  publish(id: string, port: number): Promise<{ url: string }> {
    return this.json("POST", `/v1/sandboxes/${encodeURIComponent(id)}/publish`, { port, visibility: "public" });
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const text = await this.request(method, path, body === undefined ? undefined : JSON.stringify(body), body !== undefined);
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  private async request(method: string, path: string, body?: string, isJson = false): Promise<string> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.apiKey}` };
    if (isJson) headers["content-type"] = "application/json";
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const text = await response.text();
    if (!response.ok) throw toApiError(response.status, text);
    return response.status === 204 ? "" : text;
  }
}

const toApiError = (status: number, text: string): KilnApiError => {
  try {
    const decoded = JSON.parse(text) as { error?: { code?: string; message?: string } };
    if (decoded.error?.code !== undefined) {
      return new KilnApiError(status, decoded.error.code, decoded.error.message ?? "");
    }
  } catch {
    // Not the error envelope. The raw body follows.
  }
  return new KilnApiError(status, "internal", text.trim().slice(0, 500));
};
