import { client } from "@/api/client.gen";
import { setupToken } from "@/lib/setup-token";

/**
 * The Factoree API answers a failure with {"error": string | zod flatten}. ApiError keeps the
 * status, a readable message and the field errors of a flatten object.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public fieldErrors: Record<string, string[]> = {},
    public path = "",
  ) {
    super(message);
  }
}

type Flatten = { formErrors?: unknown; fieldErrors?: unknown };

function isFlatten(value: unknown): value is Flatten {
  return typeof value === "object" && value !== null && ("formErrors" in value || "fieldErrors" in value);
}

/** parseErrorBody turns the error member of a response body into a message and field errors. */
export function parseErrorBody(body: unknown, fallback: string): { message: string; fieldErrors: Record<string, string[]> } {
  const error = typeof body === "object" && body !== null && "error" in body ? (body as { error: unknown }).error : body;
  if (typeof error === "string" && error.length > 0) return { message: error, fieldErrors: {} };
  if (isFlatten(error)) {
    const form = Array.isArray(error.formErrors) ? error.formErrors.map(String) : [];
    const fieldErrors: Record<string, string[]> = {};
    if (typeof error.fieldErrors === "object" && error.fieldErrors !== null) {
      for (const [field, messages] of Object.entries(error.fieldErrors)) {
        if (Array.isArray(messages) && messages.length > 0) fieldErrors[field] = messages.map(String);
      }
    }
    const fields = Object.entries(fieldErrors).map(([field, messages]) => `${field}: ${messages.join(", ")}`);
    const message = [...form, ...fields].join("; ");
    return { message: message || fallback, fieldErrors };
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return { message: String((error as { message: unknown }).message), fieldErrors: {} };
  }
  return { message: fallback, fieldErrors: {} };
}

const unauthorized = new Set<(path: string) => void>();

/** onUnauthorized registers a callback for a 401 response from the admin API. */
export function onUnauthorized(fn: (path: string) => void) {
  unauthorized.add(fn);
  return () => {
    unauthorized.delete(fn);
  };
}

function pathOf(request: Request | undefined): string {
  if (!request) return "";
  try {
    return new URL(request.url, window.location.origin).pathname;
  } catch {
    return request.url;
  }
}

client.setConfig({
  baseUrl: "",
  credentials: "same-origin",
  throwOnError: true,
  // Only the setup routes name the setupToken scheme. Admin routes use the session cookie.
  auth: (auth) => (auth.key === "setupToken" ? (setupToken() ?? undefined) : undefined),
});

client.interceptors.response.use((response, request) => {
  if (response.status === 401) {
    const path = pathOf(request);
    if (path.startsWith("/admin/")) unauthorized.forEach((fn) => fn(path));
  }
  return response;
});

// A network error has no response. It stays a plain error, so TanStack Query retries it.
client.interceptors.error.use((error, response, request) => {
  if (!response) return error;
  const { message, fieldErrors } = parseErrorBody(error, response.statusText || `HTTP ${response.status}`);
  return new ApiError(response.status, message, fieldErrors, pathOf(request));
});

/**
 * authFetch posts JSON to the better-auth routes under /api/auth. The OpenAPI document does not
 * describe them, so the generated client has no function for them.
 */
export async function authFetch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/auth${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const { message } = parseErrorBody(parsed, response.statusText || `HTTP ${response.status}`);
    throw new ApiError(response.status, message, {}, `/api/auth${path}`);
  }
  return parsed as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isStatus(error: unknown, status: number): boolean {
  return error instanceof ApiError && error.status === status;
}
