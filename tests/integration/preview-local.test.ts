import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { startPreview, stopPreview } from "~/domain/runs/preview.js";
import { Redactor } from "~/telemetry/redaction.js";

/** Opens an ephemeral listener, reads its assigned port, and closes it. */
const pickPort = async (): Promise<number> =>
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

const SERVER_SOURCE = `
const http = require("node:http");
const port = Number(process.env.PORT);
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1");
`;

const probe = async (url: string): Promise<{ status: number } | null> => {
  try {
    const response = await fetch(url);
    return { status: response.status };
  } catch {
    return null;
  }
};

describe("startPreview and stopPreview against a real local process", () => {
  let root: string;
  let worktree: string;
  let sandbox: LocalProcessSandbox;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-preview-"));
    sandbox = new LocalProcessSandbox({ rootDirectory: root });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("starts a real preview process and reaches it on the exposed URL", async () => {
    const port = await pickPort();
    const ref = await sandbox.create({ runId: "preview-1", tenantId: "t", projectId: "p" });
    worktree = ref.workspacePath;
    await writeFile(join(worktree, "server.cjs"), SERVER_SOURCE, "utf8");

    const handle = await startPreview({
      sandbox,
      ref,
      workingDirectory: worktree,
      preview: {
        enabled: true,
        command: "node server.cjs",
        readyUrl: `http://127.0.0.1:${port}/health`,
        timeoutSeconds: 30,
      },
      environment: { PORT: String(port) },
      probe,
      redactor: new Redactor(),
    });

    try {
      expect(handle.port).toBe(port);
      expect(handle.baseUrl).toBe(`http://127.0.0.1:${port}`);
      const response = await fetch(`${handle.baseUrl}/health`);
      expect(response.status).toBe(200);
    } finally {
      await stopPreview(sandbox, ref, handle);
    }

    // The stopped preview no longer answers.
    await expect(fetch(`${handle.baseUrl}/health`)).rejects.toThrow();

    await sandbox.destroy(ref);
  });
});
