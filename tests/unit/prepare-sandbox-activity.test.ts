import { describe, expect, it, vi } from "vitest";
import { createSandboxActivities } from "~/activities/sandbox.activities.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { SpriteReaper } from "~/domain/runs/sprite-reaper.js";
import { DEFAULT_PROJECT_DEFAULTS } from "~/domain/runs/project-runtime-config.js";
import type { SupersededSandbox } from "~/domain/runs/run-repository.js";
import { metrics } from "~/telemetry/metrics.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import type { AgentRunner } from "~/domain/runs/agent-runner.js";

const stubRunner = (name: string): AgentRunner => ({
  name,
  run: () => Promise.reject(new Error("not used")),
  resume: () => Promise.reject(new Error("not used")),
  cancel: () => Promise.resolve("no-live-session" as const),
});

const HEAD = "aaaabbbbccccddddeeeeffff0000111122223333";

const DEFAULT_CONFIG_YAML = "version: 1\nidentity:\n  product: checkout-platform\n  linear:\n    teamKey: PAY\nverify:\n  commands:\n    - name: test\n      run: npm test\n";
const BOOTSTRAP_CONFIG_YAML =
  "version: 1\nidentity:\n  product: checkout-platform\n  linear:\n    teamKey: PAY\nbootstrap:\n  command: npm ci\nverify:\n  commands:\n    - name: test\n      run: npm test\n";

interface Scripted {
  matcher: RegExp;
  result: Partial<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Builds a `FakeSandbox` that serves `yaml` for `.factoree/config.yaml`, a fixed commit SHA for
 * `git rev-parse HEAD`, and every other command as a success, unless `overrides` matches first.
 */
const sandboxWithConfig = (yaml: string, overrides: Scripted[] = []): FakeSandbox => {
  const sandbox = new FakeSandbox();
  sandbox.onExec = (command) => {
    const last = command.args[command.args.length - 1] ?? "";
    if (command.file === "cat" && last.endsWith(".factoree/config.yaml")) {
      return { exitCode: 0, stdout: yaml, stderr: "" };
    }
    if (command.file === "cat") return { exitCode: 1, stdout: "", stderr: "no such file" };
    const line = [command.file, ...command.args].join(" ");
    const scripted = overrides.find((entry) => entry.matcher.test(line));
    if (scripted !== undefined) {
      return { exitCode: 0, stdout: "", stderr: "", ...scripted.result };
    }
    if (command.file === "git" && command.args.includes("rev-parse")) {
      return { exitCode: 0, stdout: `${HEAD}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return sandbox;
};

const supersededCount = async (): Promise<number> => {
  const metric = await metrics.sandboxesDestroyed.get();
  const sample = metric.values.find(
    (value) => value.labels.adapter === "fake" && value.labels.reason === "SUPERSEDED",
  );
  return sample?.value ?? 0;
};

const build = (
  superseded: SupersededSandbox,
  secretValues: Record<string, string> = {},
  sandbox: FakeSandbox = sandboxWithConfig(DEFAULT_CONFIG_YAML),
  runners: AgentRunnerRegistry = new AgentRunnerRegistry([stubRunner("opencode"), stubRunner("claude")]),
) => {
  const runs = {
    setSandbox: vi.fn().mockResolvedValue(superseded),
    clearSandbox: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(null),
    listExpiredSandboxes: vi.fn().mockResolvedValue([]),
    createIfAbsent: vi.fn(),
    findByAgentSession: vi.fn(),
    updateStatus: vi.fn(),
    // The real store throws when the write reaches no row. The fake must not be more permissive.
    setContextContractVersion: vi.fn().mockRejectedValue(
      new Error('no Run "run-1" of tenant "tenant-1" received the Context Contract version'),
    ),
    // The real store throws when the write reaches no row. The fake must not be more permissive.
    setValidationContractVersion: vi.fn().mockRejectedValue(
      new Error('no Run "run-1" of tenant "tenant-1" received the Validation Contract version'),
    ),
    // The real store throws when the write reaches no row. The fake must not be more permissive.
    setAutonomyLevel: vi.fn().mockRejectedValue(
      new Error('no Run "run-1" of tenant "tenant-1" received the autonomy level'),
    ),
    // The real store throws when the write reaches no row. The fake must not be more permissive.
    setPublication: vi.fn().mockRejectedValue(
      new Error('no Run "run-1" of tenant "tenant-1" received the publication facts'),
    ),
    setProofPack: vi.fn().mockRejectedValue(
      new Error('no Run "run-1" of tenant "tenant-1" received the Proof Pack facts'),
    ),
  };
  const redactor = new Redactor();
  const activities = createSandboxActivities({
    sandboxManager: new SandboxManager({ sandbox }),
    sandbox,
    runs,
    reaper: new SpriteReaper({ sandboxes: { fake: sandbox }, runs }),
    secrets: new MemorySecretStore(secretValues),
    redactor,
    runners,
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
  defaults: DEFAULT_PROJECT_DEFAULTS,
  environment: {},
  organizationSkills: null,
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

  it("fails a Run whose configuration names an unknown runner, and releases the sandbox", async () => {
    const { activities, sandbox } = build(
      { spriteId: null, adapter: null },
      {},
      undefined,
      new AgentRunnerRegistry([]),
    );
    await expect(activities.prepareSandbox(input)).rejects.toBeInstanceOf(RunConfigurationError);
    expect(sandbox.destroyed.length).toBe(1);
  });
});

describe("the prepareSandbox activity and SDD section 60", () => {
  it("registers every Project secret with the redactor before it prepares anything", async () => {
    const { activities, redactor } = build({ spriteId: null, adapter: null }, { API: "fixture-secret-value" });
    await activities.prepareSandbox(input);
    expect(redactor.redact("the log holds fixture-secret-value")).toBe("the log holds [REDACTED]");
  });

  it("redacts a Project secret that a failed bootstrap command printed", async () => {
    const sandbox = sandboxWithConfig(BOOTSTRAP_CONFIG_YAML, [
      { matcher: /npm ci/, result: { exitCode: 1, stderr: "auth failed for fixture-secret-value" } },
    ]);
    const { activities } = build({ spriteId: null, adapter: null }, { API: "fixture-secret-value" }, sandbox);
    const error = await activities.prepareSandbox(input).catch((thrown: unknown) => thrown);
    expect(String(error)).not.toContain("fixture-secret-value");
    expect(String(error)).toContain("[REDACTED]");
    // The class survives the redaction, so the workflow still recognises the configuration fault.
    expect(error).toBeInstanceOf(RunConfigurationError);
  });

  it("keeps the access token of a clone URL out of the error of a failed clone", async () => {
    const sandbox = sandboxWithConfig(DEFAULT_CONFIG_YAML, [
      {
        matcher: /clone/,
        result: {
          exitCode: 128,
          stderr:
            "fatal: authentication failed for https://x-access-token:ghp_tokenvalue000000000000@github.com/acme/app.git",
        },
      },
    ]);
    const { activities } = build({ spriteId: null, adapter: null }, {}, sandbox);
    const withToken = {
      ...input,
      primary: { url: "https://x-access-token:ghp_tokenvalue000000000000@github.com/acme/app.git", ref: "main" },
    };
    const error = await activities.prepareSandbox(withToken).catch((thrown: unknown) => thrown);
    expect(String(error)).not.toContain("ghp_tokenvalue000000000000");
    expect(String(error)).not.toContain("x-access-token");
  });
});

describe("the prepareSandbox activity and the preview configuration", () => {
  const PREVIEW_CONFIG_YAML =
    "version: 1\nidentity:\n  product: checkout-platform\n  linear:\n    teamKey: PAY\n" +
    "verify:\n  commands:\n    - name: test\n      run: npm test\n" +
    "preview:\n" +
    "  enabled: true\n" +
    "  command: npm run dev -- --port 8080\n" +
    "  readyUrl: http://127.0.0.1:8080/health\n" +
    "  timeoutSeconds: 60\n";

  it("returns the preview configuration of the repository", async () => {
    const sandbox = sandboxWithConfig(PREVIEW_CONFIG_YAML);
    const { activities } = build({ spriteId: null, adapter: null }, {}, sandbox);
    const output = await activities.prepareSandbox(input);
    expect(output.preview).toEqual({
      enabled: true,
      command: "npm run dev -- --port 8080",
      readyUrl: "http://127.0.0.1:8080/health",
      timeoutSeconds: 60,
    });
  });

  it("reports no preview when the repository configures none", async () => {
    const { activities } = build({ spriteId: null, adapter: null });
    const output = await activities.prepareSandbox(input);
    expect(output.preview).toBeNull();
  });
});

describe("the prepareSandbox activity and skills", () => {
  it("returns the skill lines the manager discovered", async () => {
    const sandbox = sandboxWithConfig(DEFAULT_CONFIG_YAML);
    const base = sandbox.onExec;
    sandbox.onExec = (command) => {
      const last = command.args[command.args.length - 1] ?? "";
      if (command.file === "ls") {
        if (last === "/workspace/primary/.agents/skills") {
          return { exitCode: 0, stdout: "routes\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "no such directory" };
      }
      if (command.file === "head" && last === "/workspace/primary/.agents/skills/routes/SKILL.md") {
        return { exitCode: 0, stdout: "---\nname: routes\ndescription: Add a route.\n---\n", stderr: "" };
      }
      return base === null ? { exitCode: 0, stdout: "", stderr: "" } : base(command);
    };
    const { activities } = build({ spriteId: null, adapter: null }, {}, sandbox);
    const output = await activities.prepareSandbox(input);
    expect(output.skills.some((line) => line.startsWith("routes — Add a route."))).toBe(true);
  });

  it("returns no skill line when the checkout defines none", async () => {
    const { activities } = build({ spriteId: null, adapter: null });
    const output = await activities.prepareSandbox(input);
    expect(output.skills).toEqual([]);
  });
});
