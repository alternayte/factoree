import { describe, expect, it } from "vitest";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { FakeEvidenceStore } from "../support/fake-evidence-store.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createVerificationActivities } from "~/activities/verification.activities.js";

const build = (
  results: Record<string, { exitCode: number; stdout: string; stderr: string }>,
  secrets = new MemorySecretStore(),
) => {
  const sandbox = new FakeSandbox();
  sandbox.onExec = (command) =>
    results[command.args[command.args.length - 1] ?? ""] ?? { exitCode: 0, stdout: "", stderr: "" };
  const evidence = new FakeEvidenceStore();
  const redactor = new Redactor();
  const activities = createVerificationActivities({
    sandbox,
    evidence,
    secrets,
    redactor,
    logger: createLogger({ level: "error", redactor }),
  });
  return { activities, evidence, sandbox };
};

const input = {
  runId: "run-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  spriteId: "sprite-1",
  adapter: "fake",
  workspacePath: "/w",
  primaryPath: "/w/primary",
  timeoutMs: 60_000,
  attempt: 1,
};

describe("verify activity", () => {
  it("passes when every command exits zero", async () => {
    const { activities } = build({ "npm test": { exitCode: 0, stdout: "", stderr: "" } });
    const output = await activities.verify({ ...input, commands: [{ name: "test", run: "npm test" }] });
    expect(output.passed).toBe(true);
    expect(output.failures).toEqual([]);
    expect(output.summary).toContain("passed");
  });

  it("fails and reports the failing check when a command exits non-zero", async () => {
    const { activities } = build({ "npm test": { exitCode: 2, stdout: "", stderr: "boom\n" } });
    const output = await activities.verify({ ...input, commands: [{ name: "test", run: "npm test" }] });
    expect(output.passed).toBe(false);
    expect(output.failures).toHaveLength(1);
    expect(output.failures[0]).toContain("test");
    expect(output.failures[0]).toContain("exit code 2");
    expect(output.failures[0]).toContain("npm test");
    expect(output.summary).toContain("1 of 1");
  });

  it("writes one evidence row for each command", async () => {
    const { activities, evidence } = build({
      a: { exitCode: 0, stdout: "", stderr: "" },
      b: { exitCode: 1, stdout: "", stderr: "" },
    });
    await activities.verify({
      ...input,
      commands: [
        { name: "first", run: "a" },
        { name: "second", run: "b" },
      ],
    });
    expect(evidence.rows).toHaveLength(2);
    expect(evidence.rows.map((row) => row.source)).toEqual(["verify:first", "verify:second"]);
    expect(evidence.rows[0]?.kind).toBe("deterministic_check");
    expect(evidence.rows[0]?.metadata["exitCode"]).toBe(0);
    expect(evidence.rows[0]?.metadata["stdoutSha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.rows[0]?.metadata["stderrSha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.rows[0]?.metadata["attempt"]).toBe(1);
    expect(evidence.rows[0]?.validationAssertionId).toBeNull();
    expect(evidence.rows[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes one row per attempt, so a repair pass does not overwrite the first", async () => {
    const { activities, evidence } = build({ a: { exitCode: 1, stdout: "", stderr: "" } });
    await activities.verify({ ...input, commands: [{ name: "first", run: "a" }], attempt: 1 });
    await activities.verify({ ...input, commands: [{ name: "first", run: "a" }], attempt: 2 });
    expect(evidence.rows).toHaveLength(2);
  });

  it("is idempotent inside one attempt, so a Temporal retry writes no second row", async () => {
    const { activities, evidence } = build({ a: { exitCode: 0, stdout: "", stderr: "" } });
    await activities.verify({ ...input, commands: [{ name: "first", run: "a" }] });
    await activities.verify({ ...input, commands: [{ name: "first", run: "a" }] });
    expect(evidence.rows).toHaveLength(1);
  });

  it("injects a marked Project secret and no other", async () => {
    const secrets = new MemorySecretStore();
    await secrets.put("tenant-1", "project-1", "MARKED_SECRET", "sesame123", {
      injectIntoImplementer: true,
    });
    await secrets.put("tenant-1", "project-1", "UNMARKED_SECRET", "hidden4567");
    const { activities, sandbox } = build({}, secrets);
    await activities.verify({ ...input, commands: [{ name: "first", run: "a" }] });
    const env = sandbox.commands.at(-1)?.env ?? {};
    expect(env).toHaveProperty("MARKED_SECRET");
    expect(env).not.toHaveProperty("UNMARKED_SECRET");
  });
});

describe("verify activity, SDD section 30", () => {
  it("rejects a marked test secret that holds forbidden material", async () => {
    const secrets = new MemorySecretStore({
      FIXTURE_TOKEN: { value: `ghp_${"a".repeat(36)}`, injectIntoImplementer: true, kind: "test" },
    });
    const { activities } = build({ "npm test": { exitCode: 0, stdout: "", stderr: "" } }, secrets);

    await expect(
      activities.verify({ ...input, commands: [{ name: "test", run: "npm test" }] }),
    ).rejects.toThrow(/must not receive "FIXTURE_TOKEN"/);
  });

  it("keeps a runner credential out of the verification environment", async () => {
    const secrets = new MemorySecretStore({
      OPENCODE_API_KEY: { value: "zen-value", injectIntoImplementer: false, kind: "runner_credential" },
    });
    const { activities, sandbox } = build({ "npm test": { exitCode: 0, stdout: "", stderr: "" } }, secrets);

    await activities.verify({ ...input, commands: [{ name: "test", run: "npm test" }] });

    for (const command of sandbox.commands) {
      expect(command.env?.OPENCODE_API_KEY).toBeUndefined();
    }
  });
});
