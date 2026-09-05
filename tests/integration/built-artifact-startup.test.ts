import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTemporal } from "./support/temporal.js";

// This suite spawns the compiled artifact in dist/, not the TypeScript source, so it
// catches a defect that only the build output can show. It proves two facts. First, tsc-alias
// rewrote every "~/" import. Second, both entry points start under Node without a
// module-resolution error. A previous defect let `npm run build` exit 0 while both compiled
// entry points threw ERR_MODULE_NOT_FOUND on start, because tsc does not rewrite the "~/" path
// alias.

const distRoot = join(process.cwd(), "dist");
const apiEntry = join(distRoot, "bin", "api.js");
const workerEntry = join(distRoot, "bin", "worker.js");

const missingDistMessage =
  "dist/ is missing. Run `npm run build` before this suite. " +
  "The build step must run before the integration suite in npm run verify and in the justfile.";

const listTsFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(fullPath)));
    } else if (entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
};

// dist/bin/api.js connects to Temporal before it opens its HTTP listener, so the API test
// needs a real, reachable Temporal address. The suite starts one ephemeral local Temporal
// server with startTemporal() and points every spawned child at it, through the real
// TEMPORAL_ADDRESS variable read by src/config/env.ts.
const dummyEnv = (port: number, temporalAddress: string): NodeJS.ProcessEnv => ({
  ...process.env,
  DATABASE_URL: "postgresql://factoree:factoree@localhost:5432/factoree_dummy",
  FACTOREE_SECRET_KEY: "0".repeat(64),
  ADMIN_API_TOKEN: "a".repeat(32),
  LINEAR_WEBHOOK_SECRET: "dummy-webhook-secret",
  SPRITES_TOKEN: "dummy-sprites-token",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: Buffer.from(
    "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  ).toString("base64"),
  GITHUB_WEBHOOK_SECRET: "dummy-github-webhook-secret",
  TEMPORAL_ADDRESS: temporalAddress,
  PORT: String(port),
});

// The worker deliberately points at an address nothing listens on, so it exercises the
// "Temporal connection fails, but the module resolves" branch the task requires.
const unreachableTemporalAddress = "127.0.0.1:1";

// A port far from any developer's default 3000, chosen to avoid colliding with a running API.
const TEST_PORT = 48173;

const waitForHealthz = async (port: number, deadlineMs: number): Promise<Response> => {
  const deadline = Date.now() + deadlineMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      return response;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`/healthz did not answer within ${deadlineMs}ms: ${String(lastError)}`);
};

const collectOutput = (child: ChildProcessByStdio<null, Readable, Readable>): { text: () => string } => {
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
  });
  return { text: () => buffer };
};

const terminate = async (child: ChildProcessByStdio<null, Readable, Readable> | undefined): Promise<void> => {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

describe("built artifact startup", () => {
  const children: ChildProcessByStdio<null, Readable, Readable>[] = [];
  let temporalAddress = "";
  let stopTemporal: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    const temporal = await startTemporal();
    temporalAddress = temporal.environment.address;
    stopTemporal = temporal.stop;
  }, 60_000);

  afterAll(async () => {
    await stopTemporal();
  });

  afterEach(async () => {
    // Terminate every child spawned by a test, so a failing assertion never leaks a process.
    await Promise.all(children.splice(0).map((child) => terminate(child)));
  });

  it("emits no '~/' import anywhere in dist/", async () => {
    if (!existsSync(distRoot)) {
      throw new Error(missingDistMessage);
    }
    const files = await listTsFiles(distRoot);
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (content.includes('from "~/') || content.includes("from '~/")) {
        offenders.push(file);
      }
    }
    expect(offenders, `files that still import through the "~/" alias: ${offenders.join(", ")}`).toEqual([]);
  });

  it("starts dist/bin/api.js and answers GET /healthz with 200", async () => {
    if (!existsSync(apiEntry)) {
      throw new Error(missingDistMessage);
    }
    const child = spawn(process.execPath, [apiEntry], {
      env: dummyEnv(TEST_PORT, temporalAddress),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const output = collectOutput(child);

    const response = await waitForHealthz(TEST_PORT, 30_000);
    expect(response.status, `api output so far:\n${output.text()}`).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body).toEqual({ status: "ok" });
    expect(output.text()).not.toContain("ERR_MODULE_NOT_FOUND");

    await terminate(child);
  }, 45_000);

  it("starts dist/bin/worker.js without a module-resolution error", async () => {
    if (!existsSync(workerEntry)) {
      throw new Error(missingDistMessage);
    }
    const child = spawn(process.execPath, [workerEntry], {
      env: dummyEnv(TEST_PORT + 1, unreachableTemporalAddress),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const output = collectOutput(child);

    // The worker needs a real Temporal server. It can fail to connect. It must not fail
    // to resolve the "~" module, because that failure means the build is broken, not the
    // network.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (output.text().includes("ERR_MODULE_NOT_FOUND")) {
        break;
      }
      if (child.exitCode !== null && !output.text().includes("ERR_MODULE_NOT_FOUND")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(output.text()).not.toContain("ERR_MODULE_NOT_FOUND");

    await terminate(child);
  }, 30_000);
});
