import { createServer } from "node:net";
import type { HttpValidationFetch } from "~/domain/validation/http-validation.js";
import type { ReadinessProbe } from "~/domain/runs/preview.js";

/** Opens an ephemeral listener, reads its assigned port, and closes it. Task 10 environment note:
 * other applications on this machine hold common ports, so every fixture server must bind an
 * ephemeral port and read back its assigned port. */
export const pickPort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close(() => {
        if (port === null) reject(new Error("no ephemeral port"));
        else resolve(port);
      });
    });
  });

/** The real readiness probe, over a real HTTP request. */
export const realProbe: ReadinessProbe = async (url) => {
  try {
    const response = await fetch(url);
    return { status: response.status };
  } catch {
    return null;
  }
};

/** The real HTTP transport a validation assertion drives. Node's global `fetch`, wrapped to the
 * domain's `HttpValidationFetch` shape. */
export const realHttpFetch: HttpValidationFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, body: await response.text() };
};
