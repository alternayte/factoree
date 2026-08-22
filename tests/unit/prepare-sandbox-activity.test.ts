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

const HEAD = "aaaabbbbccccddddeeeeffff0000111122223333";

const supersededCount = async (): Promise<number> => {
  const metric = await metrics.sandboxesDestroyed.get();
  const sample = metric.values.find(
    (value) => value.labels.adapter === "fake" && value.labels.reason === "SUPERSEDED",
  );
  return sample?.value ?? 0;
};

const build = (superseded: SupersededSandbox) => {
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
  const activities = createSandboxActivities({
    sandboxManager: new SandboxManager({ sandbox }),
    sandbox,
    runs,
    reaper: new SpriteReaper({ sandboxes: { fake: sandbox }, runs }),
    logger: createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
  });
  return { activities, sandbox, runs };
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
