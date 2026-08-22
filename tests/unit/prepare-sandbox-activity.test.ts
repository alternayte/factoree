import { describe, expect, it, vi } from "vitest";
import { createSandboxActivities } from "~/activities/sandbox.activities.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { SpriteReaper } from "~/domain/runs/sprite-reaper.js";
import { DEFAULT_PROJECT_RUNTIME_CONFIG } from "~/domain/runs/project-runtime-config.js";
import type { SupersededSandbox } from "~/domain/runs/run-repository.js";
import { metrics } from "~/telemetry/metrics.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";

const HEAD = "aaaabbbbccccddddeeeeffff0000111122223333";

const supersededCount = async (): Promise<number> => {
  const metric = await metrics.sandboxesDestroyed.get();
  const sample = metric.values.find(
    (value) => value.labels.adapter === "fake" && value.labels.reason === "SUPERSEDED",
  );
  return sample?.value ?? 0;
};

const build = (superseded: SupersededSandbox, secretValues: Record<string, string> = {}) => {
  const sandbox = new FakeSandbox();
  sandbox.scriptExec(/rev-parse HEAD/, { stdout: `${HEAD}\n` });
  const runs = {
    setSandbox: vi.fn().mockResolvedValue(superseded),
    clearSandbox: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(null),
    listExpiredSandboxes: vi.fn().mockResolvedValue([]),
    createIfAbsent: vi.fn(),
    findByAgentSession: vi.fn(),
    updateStatus: vi.fn(),
  };
  const redactor = new Redactor();
  const activities = createSandboxActivities({
    sandboxManager: new SandboxManager({ sandbox }),
    sandbox,
    runs,
    reaper: new SpriteReaper({ sandboxes: { fake: sandbox }, runs }),
    secrets: new MemorySecretStore(secretValues),
    redactor,
    logger: createLogger({ level: "error", redactor, sink: () => undefined }),
  });
  return { activities, sandbox, runs, redactor };
};

const input = {
  runId: "run-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  primary: { url: "https://github.com/acme/app.git", ref: "main" },
  references: [],
  config: DEFAULT_PROJECT_RUNTIME_CONFIG,
  environment: {},
};

describe("the prepareSandbox activity", () => {
  it("destroys the sandbox the write superseded and counts the deletion", async () => {
    const { activities, sandbox } = build({ spriteId: "sprite-old", adapter: "fake" });
    const before = await supersededCount();
    await activities.prepareSandbox(input);
    expect(sandbox.destroyed).toEqual(["sprite-old"]);
    expect(await supersededCount()).toBe(before + 1);
  });

  it("does not count a deletion that failed", async () => {
    const { activities, sandbox } = build({ spriteId: "sprite-old", adapter: "fake" });
    vi.spyOn(sandbox, "destroy").mockRejectedValueOnce(new Error("api down"));
    const before = await supersededCount();
    // The Run keeps its new sandbox. The failed deletion is a leak, and the log names it.
    const output = await activities.prepareSandbox(input);
    expect(output.baseSha).toBe(HEAD);
    expect(await supersededCount()).toBe(before);
  });

  it("destroys nothing when the write superseded no sandbox", async () => {
    const { activities, sandbox } = build({ spriteId: null, adapter: null });
    const before = await supersededCount();
    await activities.prepareSandbox(input);
    expect(sandbox.destroyed).toEqual([]);
    expect(await supersededCount()).toBe(before);
  });
});

describe("the prepareSandbox activity and SDD section 60", () => {
  it("registers every Project secret with the redactor before it prepares anything", async () => {
    const { activities, redactor } = build({ spriteId: null, adapter: null }, { API: "fixture-secret-value" });
    await activities.prepareSandbox(input);
    expect(redactor.redact("the log holds fixture-secret-value")).toBe("the log holds [REDACTED]");
  });

  it("redacts a Project secret that a failed bootstrap command printed", async () => {
    const { activities, sandbox } = build({ spriteId: null, adapter: null }, { API: "fixture-secret-value" });
    sandbox.scriptExec(/npm ci/, { exitCode: 1, stderr: "auth failed for fixture-secret-value" });
    const error = await activities
      .prepareSandbox({ ...input, config: { ...input.config, bootstrapCommand: "npm ci" } })
      .catch((thrown: unknown) => thrown);
    expect(String(error)).not.toContain("fixture-secret-value");
    expect(String(error)).toContain("[REDACTED]");
    // The class survives the redaction, so the workflow still recognises the configuration fault.
    expect(error).toBeInstanceOf(RunConfigurationError);
  });

  it("keeps the access token of a clone URL out of the error of a failed clone", async () => {
    const { activities, sandbox } = build({ spriteId: null, adapter: null });
    sandbox.scriptExec(/clone/, {
      exitCode: 128,
      stderr: "fatal: authentication failed for https://x-access-token:ghp_tokenvalue000000000000@github.com/acme/app.git",
    });
    const withToken = {
      ...input,
      primary: { url: "https://x-access-token:ghp_tokenvalue000000000000@github.com/acme/app.git", ref: "main" },
    };
    const error = await activities.prepareSandbox(withToken).catch((thrown: unknown) => thrown);
    expect(String(error)).not.toContain("ghp_tokenvalue000000000000");
    expect(String(error)).not.toContain("x-access-token");
  });
});

