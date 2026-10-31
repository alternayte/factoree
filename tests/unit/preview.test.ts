/* eslint-disable @typescript-eslint/require-await -- test activity doubles intentionally return immediately */
import { describe, expect, it } from "vitest";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { Redactor } from "~/telemetry/redaction.js";
import { startPreview, stopPreview } from "~/domain/runs/preview.js";
import type { PreviewStartError } from "~/domain/runs/preview.js";
import type { PreviewConfig } from "~/domain/runs/project-runtime-config.js";

const ref = { id: "sandbox-1", adapter: "fake", workspacePath: "/workspace" };

const config: PreviewConfig = {
  enabled: true,
  command: "npm run dev -- --port 8080",
  readyUrl: "http://127.0.0.1:8080/health",
  timeoutSeconds: 5,
};

const buildBase = (sandbox: FakeSandbox) => ({
  sandbox,
  ref,
  workingDirectory: "/workspace/primary",
  preview: config,
  environment: {},
  redactor: new Redactor(),
  sleep: async () => undefined,
});

describe("startPreview", () => {
  it("checks readiness at the exposed URL, not at the sandbox-local readiness URL (FAC-46 live run)", async () => {
    // FAC-46: the worker requested http://localhost:3000/ from its own host, reached the local
    // Factoree API, and waited out the whole timeout while the preview was live on the sprite.
    const sandbox = new FakeSandbox();
    const probed: string[] = [];
    await startPreview({
      ...buildBase(sandbox),
      probe: async (url) => {
        probed.push(url);
        return { status: 200 };
      },
    });
    expect(probed).toEqual(["http://fake.invalid:8080/health"]);
  });

  it("frees the preview port before it starts the preview (FAC-44 live run)", async () => {
    // FAC-44: a process the validator agent left on the port made `next start` fail with
    // EADDRINUSE. The preview port belongs to Factoree's preview.
    const sandbox = new FakeSandbox();
    await startPreview({ ...buildBase(sandbox), probe: async () => ({ status: 200 }) });

    const free = sandbox.calls.findIndex((call) => call.startsWith("exec"));
    expect(free).toBeGreaterThanOrEqual(0);
    expect(free).toBeLessThan(sandbox.calls.indexOf("startProcess:sh"));
    const command = sandbox.commands.find((entry) => entry.args.join(" ").includes("sport = :8080"));
    expect(command).toBeDefined();
  });

  it("starts the command, waits for readiness, and exposes the port", async () => {
    const sandbox = new FakeSandbox();
    let polls = 0;
    const handle = await startPreview({
      ...buildBase(sandbox),
      probe: async () => (++polls < 3 ? null : { status: 200 }),
    });

    expect(sandbox.commands.find((entry) => entry.args.at(-1) === config.command)).toMatchObject({
      file: "sh",
      args: ["-c", config.command],
      cwd: "/workspace/primary",
    });
    expect(handle.port).toBe(8080);
    expect(handle.baseUrl).toBe("http://fake.invalid:8080");
    expect(handle.readyUrl).toBe(config.readyUrl);
    expect(polls).toBe(3);
  });

  it("fails with `exited` when the preview process dies before it answers", async () => {
    const sandbox = new FakeSandbox();
    const base = buildBase(sandbox);
    // The probe itself ends the process, so the next poll reads the exited state
    // deterministically, with no dependence on timing between two promises.
    const probe = async () => {
      sandbox.finishProcess("process-1", {
        running: false,
        exitCode: 1,
        stdout: "",
        stderr: "port 8080 is in use",
      });
      return null;
    };

    await expect(startPreview({ ...base, probe })).rejects.toMatchObject({
      name: "PreviewStartError",
      reason: "exited",
    });
  });

  it("fails with `not_ready` when the deadline passes", async () => {
    const sandbox = new FakeSandbox();
    const base = buildBase(sandbox);
    let clock = 0;
    await expect(
      startPreview({ ...base, probe: async () => null, now: () => (clock += 1_000) }),
    ).rejects.toMatchObject({ name: "PreviewStartError", reason: "not_ready" });
  });

  it("cancels the process it started when the deadline passes", async () => {
    const sandbox = new FakeSandbox();
    const base = buildBase(sandbox);
    let clock = 0;
    await expect(
      startPreview({ ...base, probe: async () => null, now: () => (clock += 1_000) }),
    ).rejects.toMatchObject({ reason: "not_ready" });

    // Rule 10. The caller holds no handle on this path, so nothing else can stop the process.
    expect(sandbox.calls).toContain("cancelProcess");
    expect((await sandbox.readProcess(ref, { id: "process-1" })).running).toBe(false);
  });

  it("cancels the process it started when the sandbox cannot expose the service", async () => {
    const sandbox = new FakeSandbox();
    sandbox.exposeService = () => Promise.reject(new Error("this adapter cannot expose a port"));
    const base = buildBase(sandbox);
    await expect(startPreview({ ...base, probe: async () => ({ status: 200 }) })).rejects.toMatchObject(
      { reason: "expose_failed" },
    );

    expect(sandbox.calls).toContain("cancelProcess");
    expect((await sandbox.readProcess(ref, { id: "process-1" })).running).toBe(false);
  });

  it("keeps the original error when the cancel of the leaked process fails", async () => {
    const sandbox = new FakeSandbox();
    sandbox.cancelProcess = () => Promise.reject(new Error("the cancel call failed"));
    const base = buildBase(sandbox);
    let clock = 0;
    await expect(
      startPreview({ ...base, probe: async () => null, now: () => (clock += 1_000) }),
    ).rejects.toMatchObject({ name: "PreviewStartError", reason: "not_ready" });
  });

  it("refuses a readiness URL with no explicit port", async () => {
    const sandbox = new FakeSandbox();
    const base = buildBase(sandbox);
    await expect(
      startPreview({
        ...base,
        preview: { ...config, readyUrl: "http://127.0.0.1/health" },
        probe: async () => ({ status: 200 }),
      }),
    ).rejects.toMatchObject({ reason: "no_port" });
  });

  it("redacts a Project secret out of the startup log", async () => {
    const sandbox = new FakeSandbox();
    const base = buildBase(sandbox);
    const redactor = new Redactor(["super-secret-value"]);
    const probe = async () => {
      sandbox.finishProcess("process-1", {
        running: false,
        exitCode: 1,
        stdout: "token=super-secret-value",
        stderr: "",
      });
      return null;
    };

    const error = (await startPreview({ ...base, redactor, probe }).catch(
      (caught: unknown) => caught,
    )) as PreviewStartError;
    expect(error.log).not.toContain("super-secret-value");
  });
});

describe("stopPreview", () => {
  it("cancels the process and does not throw when it already exited", async () => {
    const sandbox = new FakeSandbox();
    let polls = 0;
    const handle = await startPreview({
      ...buildBase(sandbox),
      probe: async () => (++polls < 2 ? null : { status: 200 }),
    });
    sandbox.finishProcess(handle.process.id, { running: false, exitCode: 0 });

    await expect(stopPreview(sandbox, ref, handle)).resolves.toBeUndefined();
    expect(sandbox.calls).toContain("cancelProcess");
  });
});
