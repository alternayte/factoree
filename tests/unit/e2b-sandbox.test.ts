import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { E2BGateway, E2BRunOptions, E2BRunResult, E2BSandboxRequest, E2BTemplateRequest } from "~/adapters/sandbox/e2b/e2b-client.js";
import { commandLine, E2BSandbox, processWrapperScript } from "~/adapters/sandbox/e2b/e2b-sandbox.js";
import { SandboxError } from "~/domain/runs/sandbox.js";

const run = promisify(execFile);

const IMAGE = `ghcr.io/alternayte/factoree-sandbox@sha256:${"c".repeat(64)}`;
const TEMPLATE = `factoree-${"c".repeat(16)}-4c-4096m`;

interface Recorded {
  builds: E2BTemplateRequest[];
  creates: E2BSandboxRequest[];
  runs: { command: string; options: E2BRunOptions }[];
  egress: string[][];
  keepAlives: number;
}

/** A fake E2B. Files live in a map, and each answer comes from the overrides. */
const fakeGateway = (
  overrides: Partial<E2BGateway> = {},
): { gateway: E2BGateway; recorded: Recorded; files: Map<string, string> } => {
  const recorded: Recorded = { builds: [], creates: [], runs: [], egress: [], keepAlives: 0 };
  const files = new Map<string, string>();
  const directories = new Set<string>();
  let next = 0;
  const gateway: E2BGateway = {
    buildTemplate: (request) => {
      recorded.builds.push(request);
      return Promise.resolve();
    },
    createSandbox: (request) => {
      recorded.creates.push(request);
      next += 1;
      return Promise.resolve(`sb${next}`);
    },
    keepAlive: () => {
      recorded.keepAlives += 1;
      return Promise.resolve();
    },
    setEgress: (_id, domains) => {
      recorded.egress.push(domains);
      return Promise.resolve();
    },
    run: (_id, command, options): Promise<E2BRunResult> => {
      recorded.runs.push({ command, options });
      return Promise.resolve({ timedOut: false, exitCode: 0, stdout: "ok", stderr: "" });
    },
    start: (_id, command, options) => {
      recorded.runs.push({ command, options: { ...options, timeoutMs: 0 } });
      return Promise.resolve();
    },
    readFile: (_id, path) => Promise.resolve(files.get(path) ?? null),
    writeFile: (_id, path, content) => {
      files.set(path, content);
      return Promise.resolve();
    },
    makeDirectory: (_id, path) => {
      directories.add(path);
      return Promise.resolve();
    },
    exists: (_id, path) => Promise.resolve(directories.has(path) || files.has(path)),
    host: (id, port) => Promise.resolve(`${port}-${id}.e2b.app`),
    snapshot: () => Promise.resolve("snap1"),
    deleteSnapshot: () => Promise.resolve(false),
    kill: () => Promise.resolve(),
    ...overrides,
  };
  return { gateway, recorded, files };
};

const input = { runId: "run-1", tenantId: "t1", productId: "p1", environment: { RUNNER_TOKEN: "secret" } };

describe("E2BSandbox (docs/specs/e2b-sandbox-provider.md)", () => {
  it("builds the template of the image digest once as the user agent, and creates sandboxes with no environment", async () => {
    const { gateway, recorded } = fakeGateway();
    const sandbox = new E2BSandbox({ gateway, image: IMAGE });
    const first = await sandbox.create(input);
    await sandbox.create({ ...input, runId: "run-2" });
    expect(recorded.builds).toEqual([{ name: TEMPLATE, image: IMAGE, user: "agent", cpuCount: 4, memoryMb: 4096 }]);
    expect(recorded.creates[0]).toEqual({
      source: TEMPLATE,
      metadata: { factoree_run_id: "run-1", factoree_tenant_id: "t1" },
      timeoutMs: 600_000,
    });
    expect(first).toEqual({ id: "sb1", adapter: "e2b", workspacePath: "/home/agent/workspace" });
  });

  it("opens /dev/net/tun and /dev/fuse as root after each create and restore, for rootless Docker (DI-21.29)", async () => {
    const { gateway, recorded } = fakeGateway();
    const sandbox = new E2BSandbox({ gateway, image: IMAGE });
    await sandbox.create(input);
    await sandbox.warmSnapshots.restore(input, "snap1");
    const chmods = recorded.runs.filter((run) => run.options.user === "root");
    expect(chmods).toHaveLength(2);
    expect(chmods[0]?.command).toContain("chmod 0666 /dev/net/tun /dev/fuse");
    expect(chmods[0]?.options.envs).toEqual({});
  });

  it("builds the template again after a failed build", async () => {
    let calls = 0;
    const { gateway } = fakeGateway({
      buildTemplate: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("pull denied")) : Promise.resolve();
      },
    });
    const sandbox = new E2BSandbox({ gateway, image: IMAGE });
    await expect(sandbox.create(input)).rejects.toThrow(SandboxError);
    await expect(sandbox.create(input)).resolves.toMatchObject({ adapter: "e2b" });
    expect(calls).toBe(2);
  });

  it("restores a warm snapshot under the metadata of the restoring run (issue #5)", async () => {
    const { gateway, recorded } = fakeGateway();
    const sandbox = new E2BSandbox({ gateway, image: IMAGE });
    await sandbox.warmSnapshots.restore({ ...input, runId: "run-9" }, "snap1");
    expect(recorded.creates[0]?.source).toBe("snap1");
    expect(recorded.creates[0]?.metadata.factoree_run_id).toBe("run-9");
    // A snapshot that E2B no longer has counts as removed.
    await expect(sandbox.warmSnapshots.remove("gone")).resolves.toBe(true);
  });

  it("sends the normalized allow list as the egress rules", async () => {
    const { gateway, recorded } = fakeGateway();
    const sandbox = new E2BSandbox({ gateway, image: IMAGE });
    const ref = await sandbox.create(input);
    await sandbox.applyNetworkPolicy(ref, { allowedDomains: ["GitHub.com", "*.npmjs.org", "github.com"] });
    await sandbox.applyNetworkPolicy(ref, { allowedDomains: [] });
    expect(recorded.egress).toEqual([["*.npmjs.org", "github.com"], []]);
  });

  it("keeps the attached environment from an isolated command, and sends no limit for a command without one", async () => {
    const { gateway, recorded } = fakeGateway();
    const sandbox = new E2BSandbox({ gateway, image: IMAGE });
    const ref = await sandbox.create(input);
    await sandbox.exec(ref, { file: "npm", args: ["test"], cwd: "repo", isolated: true });
    await sandbox.exec(ref, { file: "npm", args: ["test"] });
    // runs[0] is the root device chmod of the create (DI-21.29).
    expect(recorded.runs[1]?.options.envs.RUNNER_TOKEN).toBeUndefined();
    expect(recorded.runs[1]?.options).toMatchObject({ cwd: "/home/agent/workspace/repo", user: "agent", timeoutMs: 0 });
    expect(recorded.runs[2]?.options.envs.RUNNER_TOKEN).toBe("secret");
  });

  it("reports a command that reached its limit with exit code 124", async () => {
    const { gateway } = fakeGateway({ run: () => Promise.resolve({ timedOut: true, stdout: "partial", stderr: "" }) });
    const sandbox = new E2BSandbox({ gateway, image: IMAGE });
    const ref = await sandbox.create(input);
    const result = await sandbox.exec(ref, { file: "npm", args: ["test"], timeoutMs: 5_000 });
    expect(result).toMatchObject({ exitCode: 124, timedOut: true, stdout: "partial" });
  });

  it("reads a process from its files, and refuses an identifier it never issued", async () => {
    const { gateway, files } = fakeGateway();
    const sandbox = new E2BSandbox({ gateway, image: IMAGE });
    const ref = await sandbox.create(input);
    const process = await sandbox.startProcess(ref, { file: "opencode", args: ["run"] });
    const dir = `/home/agent/.factoree/proc/${process.id}`;
    files.set(`${dir}/out`, "working");
    await expect(sandbox.readProcess(ref, process)).resolves.toEqual({
      running: true,
      exitCode: null,
      stdout: "working",
      stderr: "",
    });
    files.set(`${dir}/exit`, "3\n");
    await expect(sandbox.readProcess(ref, process)).resolves.toMatchObject({ running: false, exitCode: 3 });
    await expect(sandbox.readProcess(ref, { id: "proc-never" })).rejects.toThrow(SandboxError);
  });

  it("moves the sandbox timeout at most once a minute", async () => {
    let now = 0;
    const { gateway, recorded } = fakeGateway();
    const sandbox = new E2BSandbox({ gateway, image: IMAGE, now: () => now });
    const ref = await sandbox.create(input);
    await sandbox.exec(ref, { file: "true", args: [] });
    now = 59_000;
    await sandbox.exec(ref, { file: "true", args: [] });
    now = 60_000;
    await sandbox.exec(ref, { file: "true", args: [] });
    expect(recorded.keepAlives).toBe(1);
  });

  it("passes a failed kill to the caller, because E2B keeps a paused sandbox until a kill", async () => {
    const { gateway } = fakeGateway({ kill: () => Promise.reject(new Error("e2b: 503")) });
    const sandbox = new E2BSandbox({ gateway, image: IMAGE });
    const ref = await sandbox.create(input);
    await expect(sandbox.destroy(ref)).rejects.toThrow("e2b: 503");
  });

  it("exposes a port at the https URL of its E2B host", async () => {
    const { gateway } = fakeGateway();
    const sandbox = new E2BSandbox({ gateway, image: IMAGE });
    const ref = await sandbox.create(input);
    await expect(sandbox.exposeService(ref, 3000)).resolves.toEqual({ port: 3000, url: "https://3000-sb1.e2b.app" });
  });
});

describe("the E2B command line and process wrapper, under a real shell", () => {
  it("passes each argument intact and sets PATH again after the login shell", async () => {
    const print = 'printf "%s|" "$@"; echo; echo "$PATH"';
    const line = commandLine(["sh", "-c", print, "sh", "a b", "it's", "$HOME", '--x="y"'], {
      PATH: "/opt/factoree/bin:/usr/bin:/bin",
    });
    // The login shell replaces PATH before the command string runs.
    const { stdout } = await run("/bin/sh", ["-c", `PATH=/nowhere; ${line}`]);
    expect(stdout).toBe('a b|it\'s|$HOME|--x="y"|\n/opt/factoree/bin:/usr/bin:/bin\n');
  });

  it("writes the output, the pid and, last, the exit code, and starts nothing after a cancel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2b-proc-"));
    await run("sh", ["-c", processWrapperScript(dir), "sh", "sh", "-c", "echo out; echo err >&2; exit 7"]);
    expect(await readFile(join(dir, "out"), "utf8")).toBe("out\n");
    expect(await readFile(join(dir, "err"), "utf8")).toBe("err\n");
    expect((await readFile(join(dir, "exit"), "utf8")).trim()).toBe("7");
    expect((await readFile(join(dir, "pid"), "utf8")).trim()).toMatch(/^[0-9]+$/);

    const cancelled = await mkdtemp(join(tmpdir(), "e2b-proc-"));
    await writeFile(join(cancelled, "cancel"), "");
    await run("sh", ["-c", processWrapperScript(cancelled), "sh", "sh", "-c", "echo started"]);
    expect((await readFile(join(cancelled, "exit"), "utf8")).trim()).toBe("143");
    await expect(readFile(join(cancelled, "out"), "utf8")).rejects.toThrow();
  });
});
