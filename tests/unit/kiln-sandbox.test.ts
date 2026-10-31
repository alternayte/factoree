import { describe, expect, it } from "vitest";
import { KilnClient } from "~/adapters/sandbox/kiln/kiln-client.js";
import { KilnSandbox, templateName } from "~/adapters/sandbox/kiln/kiln-sandbox.js";
import { SandboxError } from "~/domain/runs/sandbox.js";

const IMAGE = `ghcr.io/alternayte/factoree-sandbox@sha256:${"c".repeat(64)}`;
const TEMPLATE = `factoree-${"c".repeat(16)}`;

interface Call {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (call: Call) => { status: number; body?: unknown } | undefined;

/** A fake Kiln API. Each handler answers the calls it knows. Every call is recorded. */
const fakeKiln = (handler: Handler): { client: KilnClient; calls: Call[] } => {
  const calls: Call[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const text = typeof init?.body === "string" ? init.body : undefined;
    let body: unknown = text;
    try {
      if (text !== undefined) body = JSON.parse(text);
    } catch {
      // A file body stays text.
    }
    const call = { method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, body };
    calls.push(call);
    const answer = handler(call) ?? { status: 404, body: { error: { code: "not_found", message: call.path } } };
    return Promise.resolve(
      new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status }),
    );
  };
  return { client: new KilnClient({ baseUrl: "https://kiln.test", apiKey: "k", fetch: fetchStub }), calls };
};

const process = (fields: Partial<Record<string, unknown>>): Record<string, unknown> => ({
  id: "p1",
  running: false,
  exit_code: 0,
  stdout: "",
  stderr: "",
  stdout_offset: 0,
  stderr_offset: 0,
  stdout_lost: 0,
  stderr_lost: 0,
  more: false,
  ...fields,
});

const ref = { id: "sb1", adapter: "kiln", workspacePath: "/home/agent/workspace" };

describe("KilnSandbox (docs/specs/kiln-sandbox-provider.md)", () => {
  it("builds one template per image digest as the user agent, and creates persistent sandboxes with no environment", async () => {
    let built = false;
    const { client, calls } = fakeKiln((call) => {
      if (call.method === "GET" && call.path === `/v1/templates/${TEMPLATE}`) {
        return built ? { status: 200, body: { name: TEMPLATE, image: IMAGE, state: "ready" } } : undefined;
      }
      if (call.method === "POST" && call.path === "/v1/templates") {
        built = true;
        return { status: 202, body: {} };
      }
      if (call.method === "POST" && call.path === "/v1/sandboxes") return { status: 201, body: { id: "sb1", state: "running", egress_allow: [] } };
      return undefined;
    });
    const sandbox = new KilnSandbox({ client, image: IMAGE, pollMs: 0 });

    await sandbox.create({ runId: "r1", tenantId: "t1", productId: "p1", environment: { TEST_SECRET: "s" } });
    await sandbox.create({ runId: "r2", tenantId: "t1", productId: "p1" });

    const template = calls.find((call) => call.path === "/v1/templates");
    expect(template?.body).toMatchObject({ name: TEMPLATE, image: IMAGE, user: "agent", egress_allow: [], setup: [] });
    expect(calls.filter((call) => call.path === "/v1/templates")).toHaveLength(1);
    const sandboxes = calls.filter((call) => call.path === "/v1/sandboxes");
    expect(sandboxes).toHaveLength(2);
    // An environment at create time makes a secret-bearing sandbox, whose snapshot then refuses a restore.
    expect(sandboxes[0]?.body).toMatchObject({ template: TEMPLATE, lifecycle: "persistent" });
    expect(sandboxes[0]?.body).not.toHaveProperty("env");
  });

  it("fails with the reason Kiln gives for a failed template build, and deletes the template", async () => {
    const { client, calls } = fakeKiln((call) => {
      if (call.method === "GET") return { status: 200, body: { name: TEMPLATE, image: IMAGE, state: "failed", error: "pull denied" } };
      if (call.method === "DELETE") return { status: 204 };
      return undefined;
    });
    const sandbox = new KilnSandbox({ client, image: IMAGE, pollMs: 0 });
    await expect(sandbox.create({ runId: "r1", tenantId: "t1", productId: "p1" })).rejects.toThrow(/pull denied/);
    // The failed template goes, so the next attempt builds it again once the cause is fixed.
    expect(calls).toContainEqual({ method: "DELETE", path: `/v1/templates/${TEMPLATE}`, body: undefined });
  });

  it("runs exec as a detached process with the runner PATH first, and reads every page of output", async () => {
    let reads = 0;
    const { client, calls } = fakeKiln((call) => {
      if (call.method === "POST" && call.path === "/v1/sandboxes/sb1/processes") return { status: 201, body: { id: "p1" } };
      if (call.method === "GET" && call.path.startsWith("/v1/sandboxes/sb1/processes/p1")) {
        reads += 1;
        if (reads === 1) return { status: 200, body: process({ running: true, exit_code: null, stdout: "a", stdout_offset: 1, more: true }) };
        if (reads === 2) return { status: 200, body: process({ running: true, exit_code: null, stdout: "b", stdout_offset: 2 }) };
        return { status: 200, body: process({ exit_code: 3, stdout: "c", stdout_offset: 3, stderr: "e", stderr_offset: 1 }) };
      }
      return undefined;
    });
    const sandbox = new KilnSandbox({ client, image: IMAGE, pollMs: 0 });
    sandbox.attachEnvironment(ref, { TEST_SECRET: "s" });

    const result = await sandbox.exec(ref, { file: "git", args: ["status"], cwd: "primary" });

    expect(result).toMatchObject({ exitCode: 3, stdout: "abc", stderr: "e", timedOut: false });
    const start = calls[0]?.body as { cmd: string[]; cwd: string; env: Record<string, string> };
    expect(start.cmd).toEqual(["git", "status"]);
    expect(start.cwd).toBe("/home/agent/workspace/primary");
    expect(start.env.PATH?.startsWith("/opt/factoree/bin:")).toBe(true);
    expect(start.env.TEST_SECRET).toBe("s");
    // Each read asks only for what follows the last offsets.
    expect(calls.map((call) => call.path).slice(1)).toEqual([
      "/v1/sandboxes/sb1/processes/p1?stdout_offset=0&stderr_offset=0",
      "/v1/sandboxes/sb1/processes/p1?stdout_offset=1&stderr_offset=0",
      "/v1/sandboxes/sb1/processes/p1?stdout_offset=2&stderr_offset=0",
    ]);
  });

  it("keeps the attached environment from an isolated command", async () => {
    const { client, calls } = fakeKiln((call) => {
      if (call.method === "POST") return { status: 201, body: { id: "p1" } };
      return { status: 200, body: process({}) };
    });
    const sandbox = new KilnSandbox({ client, image: IMAGE, pollMs: 0 });
    sandbox.attachEnvironment(ref, { RUNNER_KEY: "secret" });
    await sandbox.exec(ref, { file: "npm", args: ["test"], isolated: true });
    expect((calls[0]?.body as { env: Record<string, string> }).env).not.toHaveProperty("RUNNER_KEY");
  });

  it("fails a command whose output Kiln could not keep, so a diff is never truncated", async () => {
    const { client } = fakeKiln((call) => {
      if (call.method === "POST") return { status: 201, body: { id: "p1" } };
      return { status: 200, body: process({ stdout: "tail", stdout_offset: 9_000_000, stdout_lost: 600_000 }) };
    });
    const sandbox = new KilnSandbox({ client, image: IMAGE, pollMs: 0 });
    await expect(sandbox.exec(ref, { file: "git", args: ["diff"] })).rejects.toBeInstanceOf(SandboxError);
  });

  it("kills a command at its deadline and reports a timeout", async () => {
    const { client, calls } = fakeKiln((call) => {
      if (call.method === "POST") return { status: 201, body: { id: "p1" } };
      if (call.method === "DELETE") return { status: 204 };
      return { status: 200, body: process({ running: true, exit_code: null }) };
    });
    const sandbox = new KilnSandbox({ client, image: IMAGE, pollMs: 0 });
    const result = await sandbox.exec(ref, { file: "sleep", args: ["60"], timeoutMs: 0 });
    expect(result.timedOut).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/sandboxes/sb1/processes/p1?signal=KILL" });
  });

  it("replaces the egress list of the sandbox with the normalized policy", async () => {
    const { client, calls } = fakeKiln(() => ({ status: 200, body: { id: "sb1", state: "running", egress_allow: [] } }));
    const sandbox = new KilnSandbox({ client, image: IMAGE, pollMs: 0 });
    await sandbox.applyNetworkPolicy(ref, { allowedDomains: ["Registry.npmjs.org", "*.github.com", "registry.npmjs.org"] });
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/v1/sandboxes/sb1/egress",
      body: { egress_allow: ["*.github.com", "registry.npmjs.org"] },
    });
  });

  it("refuses an image named by tag, because one template serves one digest", () => {
    expect(() => templateName("ghcr.io/alternayte/factoree-sandbox:latest")).toThrow(/digest/);
  });
});

describe("KilnClient retries (a Kiln restart answers 502 for a while)", () => {
  const flaky = (failures: number, status: number | "network") => {
    const calls: string[] = [];
    const fetchStub: typeof fetch = (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(input instanceof Request ? input.url : input).pathname}`);
      if (calls.length <= failures) {
        if (status === "network") return Promise.reject(new TypeError("fetch failed"));
        return Promise.resolve(new Response(JSON.stringify({ error: { code: "internal", message: "the host is not reachable" } }), { status }));
      }
      return Promise.resolve(new Response(JSON.stringify(process({ exit_code: 0 })), { status: 200 }));
    };
    return { client: new KilnClient({ baseUrl: "https://kiln.test", apiKey: "k", fetch: fetchStub, retryDelaysMs: [0, 0, 0] }), calls };
  };

  it("repeats a read through a 502 and a network fault", async () => {
    const gateway = flaky(2, 502);
    await expect(gateway.client.readProcess("sb1", "p1", 0, 0)).resolves.toMatchObject({ exit_code: 0 });
    expect(gateway.calls).toHaveLength(3);
    const network = flaky(1, "network");
    await expect(network.client.readProcess("sb1", "p1", 0, 0)).resolves.toMatchObject({ exit_code: 0 });
  });

  it("repeats a POST only on a 502, so a process never starts twice", async () => {
    const gateway = flaky(1, 502);
    await expect(gateway.client.startProcess("sb1", { cmd: ["true"] })).resolves.toBe("p1");
    expect(gateway.calls).toHaveLength(2);
    const timeout = flaky(1, 504);
    await expect(timeout.client.startProcess("sb1", { cmd: ["true"] })).rejects.toThrow(/HTTP 504/);
    expect(timeout.calls).toHaveLength(1);
  });

  it("gives up after the last delay, and never repeats a 4xx", async () => {
    const down = flaky(10, 503);
    await expect(down.client.readProcess("sb1", "p1", 0, 0)).rejects.toThrow(/HTTP 503/);
    expect(down.calls).toHaveLength(4);
    const missing = flaky(10, 404);
    await expect(missing.client.readProcess("sb1", "p1", 0, 0)).rejects.toThrow(/HTTP 404/);
    expect(missing.calls).toHaveLength(1);
  });
});

describe("KilnSandbox warm snapshot restore (issue #5)", () => {
  it("names the restoring run in the copy's metadata, not the run that took the snapshot", async () => {
    const { client, calls } = fakeKiln((call) =>
      call.method === "POST" ? { status: 201, body: { sandboxes: [{ id: "copy-1", state: "running", egress_allow: [] }] } } : undefined,
    );
    const sandbox = new KilnSandbox({ client, image: IMAGE, pollMs: 0 });
    const ref = await sandbox.warmSnapshots.restore({ runId: "run-2", tenantId: "t1", productId: "p1" }, "snap-1");
    expect(ref.id).toBe("copy-1");
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/v1/snapshots/snap-1/restore",
      body: { count: 1, allow_secret_fork: false, metadata: { factoree_run_id: "run-2", factoree_tenant_id: "t1" } },
    });
  });
});
