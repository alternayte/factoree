import { globalCredentialValuePatterns } from "~/domain/security/credential-formats.js";

const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "access_token",
  "refresh_token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
]);

// The provider credential formats come from the one shared list. See
// `src/domain/security/credential-formats.ts`. The bearer-header pattern stays here, because it
// is a log-line shape, not a provider credential value format.
const PATTERNS: RegExp[] = [
  ...globalCredentialValuePatterns(),
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class Redactor {
  private readonly secrets = new Set<string>();

  constructor(secrets: Iterable<string> = []) {
    for (const secret of secrets) this.addSecret(secret);
  }

  addSecret(value: string): void {
    // Four characters is the floor. A shorter value would redact ordinary words out of every
    // log line. A Project secret shorter than four characters is a configuration fault, not a
    // redaction fault.
    if (value.length >= 4) this.secrets.add(value);
  }

  redact<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === "string") return this.redactString(value);
    if (Array.isArray(value)) return value.map((item) => this.walk(item));
    if (value instanceof Error) {
      const error = new Error(this.redactString(value.message));
      error.name = value.name;
      if (value.stack) error.stack = this.redactString(value.stack);
      return error;
    }
    if (value !== null && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        output[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : this.walk(item);
      }
      return output;
    }
    return value;
  }

  private redactString(value: string): string {
    let output = value;
    for (const secret of this.secrets) {
      output = output.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
    }
    for (const pattern of PATTERNS) {
      output = output.replace(pattern, REDACTED);
    }
    return output;
  }
}
