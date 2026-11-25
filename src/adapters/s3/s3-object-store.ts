import { createHash, createHmac } from "node:crypto";

/**
 * docs/specs/retro-agent.md. A small S3-compatible object client: put, get and delete of one key,
 * signed with AWS Signature Version 4 over path-style URLs, so AWS S3, MinIO, Cloudflare R2 and
 * Backblaze B2 all work. Three calls do not earn the AWS SDK. No message holds the secret key.
 */
export interface S3Location {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
}

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const TIMEOUT_MS = 30_000;

const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string): Buffer => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding of one path segment, as SigV4 requires. */
const encodeSegment = (segment: string): string =>
  encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** The path-style URL of one object: `<endpoint>/<bucket>/<key>`, each segment encoded. */
export const objectUrlOf = (location: Pick<S3Location, "endpoint" | "bucket">, key: string): { host: string; origin: string; path: string } => {
  const endpoint = new URL(location.endpoint);
  const basePath = endpoint.pathname.replace(/\/+$/, "");
  return {
    host: endpoint.host,
    origin: `${endpoint.protocol}//${endpoint.host}`,
    path: `${basePath}/${encodeSegment(location.bucket)}/${key.split("/").map(encodeSegment).join("/")}`,
  };
};

/** The SigV4 headers of one request with no query string. */
export const signS3Request = (
  credentials: Pick<S3Location, "region" | "accessKey" | "secretKey">,
  request: { method: string; host: string; path: string; payloadHash: string; headers?: Record<string, string> },
  now: Date,
): Record<string, string> => {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: request.host,
    "x-amz-content-sha256": request.payloadHash,
    "x-amz-date": amzDate,
    ...Object.fromEntries(Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
  };
  const names = Object.keys(headers).sort();
  const canonical = [request.method, request.path, "", ...names.map((name) => `${name}:${headers[name]!.trim()}`), "", names.join(";"), request.payloadHash].join("\n");
  const scope = `${day}/${credentials.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretKey}`, day), credentials.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  const { host: _host, ...sent } = headers;
  void _host;
  return { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
};

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly location: S3Location,
    private readonly call: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async send(method: string, key: string, body?: Buffer, contentType?: string): Promise<Response> {
    const url = objectUrlOf(this.location, key);
    const headers = signS3Request(
      this.location,
      { method, host: url.host, path: url.path, payloadHash: sha256Hex(body ?? ""), headers: contentType === undefined ? {} : { "content-type": contentType } },
      this.clock(),
    );
    return this.call(`${url.origin}${url.path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: new Uint8Array(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  private failure(action: string, key: string, response: Response): Error {
    return new Error(`the transcript bucket ${this.location.bucket} answered ${response.status} to the ${action} of ${key}`);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const response = await this.send("PUT", key, body, contentType);
    if (!response.ok) throw this.failure("upload", key, response);
  }

  async get(key: string): Promise<Buffer | null> {
    const response = await this.send("GET", key);
    if (response.status === 404) return null;
    if (!response.ok) throw this.failure("download", key, response);
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const response = await this.send("DELETE", key);
    if (!response.ok && response.status !== 404) throw this.failure("delete", key, response);
  }
}
