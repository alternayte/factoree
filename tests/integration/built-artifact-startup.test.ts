import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTemporal } from "./support/temporal.js";
import { startDatabase } from "./support/database.js";

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
// needs a real, reachable Temporal address. It issues the setup token in the database before it
// listens, so it needs a migrated database too. The suite starts both and points every spawned
// child at them through the variables src/config/env.ts reads.
const dummyEnv = (port: number, temporalAddress: string, databaseUrl: string): NodeJS.ProcessEnv => ({
  ...process.env,
  FACTOREE_DATABASE_URL: databaseUrl,
  FACTOREE_MASTER_KEY: "3f9a1c7e52b04d86a1e9c3f7b2d50e48".repeat(2),
  FACTOREE_PUBLIC_URL: `http://127.0.0.1:${port}`,
  FACTOREE_TEMPORAL_ADDRESS: temporalAddress,
  FACTOREE_PORT: String(port),
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
  let databaseUrl = "";
  let stopDatabase: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    const temporal = await startTemporal();
    temporalAddress = temporal.environment.address;
    stopTemporal = temporal.stop;
    const database = await startDatabase();
    databaseUrl = database.url;
    stopDatabase = database.stop;
  }, 60_000);

  afterAll(async () => {
    await stopTemporal();
    await stopDatabase();
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
      env: dummyEnv(TEST_PORT, temporalAddress, databaseUrl),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const output = collectOutput(child);

    const response = await waitForHealthz(TEST_PORT, 30_000);
    expect(response.status, `api output so far:\n${output.text()}`).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body).toEqual({ status: "ok" });
    expect(output.text()).not.toContain("ERR_MODULE_NOT_FOUND");
    // docs/specs/release-0-1-0.md. A start with no completed setup names the one-time setup token.
    const tokenLine = /enter the setup token [A-Za-z0-9_-]{20,}/;
    const logDeadline = Date.now() + 5_000;
    while (!tokenLine.test(output.text()) && Date.now() < logDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(output.text()).toMatch(tokenLine);

    await terminate(child);
  }, 45_000);

  it("starts dist/bin/worker.js without a module-resolution error", async () => {
    if (!existsSync(workerEntry)) {
      throw new Error(missingDistMessage);
    }
    const child = spawn(process.execPath, [workerEntry], {
      env: dummyEnv(TEST_PORT + 1, unreachableTemporalAddress, databaseUrl),
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
