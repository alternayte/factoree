import { describe, expect, it } from "vitest";
import { hostHintsOf } from "~/domain/diagnostics/host-hints.js";
import { recordRunEvent, type RunEventRecorder, type RunEventStore } from "~/domain/diagnostics/run-event.js";
import { runDiagnosisOf } from "~/domain/diagnostics/diagnosis.js";
import { recordSessionFaults } from "~/activities/agent-session-recording.js";
import type { AgentRunResult } from "~/domain/runs/agent-runner.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { MemoryRunEventStore } from "../support/memory-run-event-store.js";

const SECRET = "sk-ant-test-0123456789abcdef";

const recorderOf = (store: RunEventStore = new MemoryRunEventStore()): RunEventRecorder => {
  const redactor = new Redactor([SECRET]);
  return { store, redactor, logger: createLogger({ level: "error", redactor, sink: () => undefined }) };
};

const failedResult = (overrides: Partial<AgentRunResult> = {}): AgentRunResult => ({
  session: { sessionId: "s-1", processId: "p-1", runner: "claude" },
  completed: false,
  exitCode: 1,
  summary: "API Error",
  durationMs: 1_000,
  cancelled: false,
  failureLog: "--- stdout ---\nfetch https://registry.private.example/pkg failed\n--- stderr ---\n",
  outcome: "failed",
  silenceLimitMs: 600_000,
  usage: null,
  model: "anthropic/claude",
  effort: null,
  ...overrides,
});

describe("hostHintsOf", () => {
  it("names hosts from URLs and bare names that the allow list does not hold", () => {
    const log = [
      "GET https://registry.npmjs.org/left-pad 200",
      "getaddrinfo ENOTFOUND tuf-repo-cdn.sigstore.dev",
      "Unable to reach cdn.functions.azure.com",
      "at src.app.module.ts:12 in tests.unit.config.json",
    ].join("\n");
    expect(hostHintsOf(log, ["registry.npmjs.org", "*.azure.com"])).toEqual(["tuf-repo-cdn.sigstore.dev"]);
  });

  it("gives no hints without output", () => {
    expect(hostHintsOf(null, [])).toEqual([]);
  });
});

describe("recordRunEvent", () => {
  it("redacts every string before the write, and a retry writes no second row", async () => {
    const store = new MemoryRunEventStore();
    const recorder = recorderOf(store);
    const event = {
      tenantId: "t-1",
      subject: { runId: "run-1" },
      stage: "PREPARING",
      attempt: 0,
      role: null,
      kind: "command_failed" as const,
      message: `bootstrap failed with ${SECRET}`,
      detail: {
        step: "bootstrap",
        command: "npm ci",
        exitCode: 1,
        durationMs: 10,
        log: `token=${SECRET}`,
        egress: "not_recorded" as const,
        deniedHosts: [],
        hostHints: [],
      },
      idempotencyKey: "prepare:sbx:bootstrap:acme/app",
    };
    await recordRunEvent(recorder, event);
    await recordRunEvent(recorder, event);
    expect(store.events).toHaveLength(1);
    expect(JSON.stringify(store.events[0])).not.toContain(SECRET);
  });

  it("never throws when the write fails", async () => {
    const failing = new MemoryRunEventStore();
    failing.record = () => Promise.reject(new Error("db down"));
    await expect(
      recordRunEvent(recorderOf(failing), {
        tenantId: "t-1",
        subject: { runId: "run-1" },
        stage: "REFINING",
        attempt: 1,
        role: "refiner",
        kind: "proposal_rejected",
        message: "bad",
        detail: { problem: "bad" },
        idempotencyKey: "k",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("recordSessionFaults", () => {
  const context = { tenantId: "t-1", runId: "run-1", role: "implementer" as const, attempt: 2, runner: "claude", idempotencyKey: "run:run-1:implementer:2" };

  it("records a failed session with its log, the hosts the egress log denied and the host hints", async () => {
    const store = new MemoryRunEventStore();
    const sandbox = {
      egressLog: () => Promise.resolve([
        { host: "registry.private.example", decision: "denied" as const },
        { host: "api.anthropic.com", decision: "allowed" as const },
      ]),
    } as unknown as Sandbox;
    await recordSessionFaults(
      recorderOf(store),
      { ...context, egress: { sandbox, ref: { id: "sbx", adapter: "kiln", workspacePath: "/w" }, allowList: ["api.anthropic.com"] } },
      [failedResult()],
    );
    const [event] = store.events;
    expect(event?.kind).toBe("session_failed");
    if (event?.kind !== "session_failed") return;
    expect(event.detail.egress).toBe("recorded");
    expect(event.detail.deniedHosts).toEqual(["registry.private.example"]);
    expect(event.detail.hostHints).toEqual(["registry.private.example"]);
    expect(event.message).toContain("The sandbox egress log denied registry.private.example.");
  });

  it("says when the sandbox provider records no egress", async () => {
    const store = new MemoryRunEventStore();
    await recordSessionFaults(
      recorderOf(store),
      { ...context, egress: { sandbox: {} as Sandbox, ref: { id: "sbx", adapter: "e2b", workspacePath: "/w" }, allowList: [] } },
      [failedResult()],
    );
    expect(store.events[0]?.kind === "session_failed" && store.events[0].detail.egress).toBe("not_recorded");
  });

  it("records a hang, and nothing for a finished or stopped session", async () => {
    const store = new MemoryRunEventStore();
    await recordSessionFaults(recorderOf(store), context, [
      failedResult({ completed: true, exitCode: 0, failureLog: null, outcome: "finished" }),
      failedResult({ cancelled: true }),
      failedResult({ outcome: "hung", cancelled: true }),
    ]);
    expect(store.events.map((event) => event.kind)).toEqual(["session_hung"]);
  });
});

describe("runDiagnosisOf", () => {
  it("names the fault that the end of the run links to", async () => {
    const store = new MemoryRunEventStore();
    const recorder = recorderOf(store);
    await recordSessionFaults(recorder, { tenantId: "t-1", runId: "run-1", role: "validator", attempt: 1, runner: "claude", idempotencyKey: "v" }, [failedResult()]);
    const cause = store.events[0];
    await recordRunEvent(recorder, {
      tenantId: "t-1",
      subject: { runId: "run-1" },
      stage: "USER_VALIDATING",
      attempt: 1,
      role: null,
      kind: "run_ended",
      message: "User validation did not pass.",
      detail: { status: "FAILED", reason: "VALIDATION_FAILED", lastStatus: "USER_VALIDATING", causeEventId: cause?.id ?? null },
      idempotencyKey: "run:run-1:ended",
    });
    const diagnosis = await runDiagnosisOf(store, "t-1", { id: "run-1", status: "FAILED", failureReason: "VALIDATION_FAILED", failureMessage: "User validation did not pass." });
    expect(diagnosis?.stage).toBe("USER_VALIDATING");
    expect(diagnosis?.cause?.id).toBe(cause?.id);
  });

  it("is null for a run that did not fail", async () => {
    expect(await runDiagnosisOf(new MemoryRunEventStore(), "t-1", { id: "r", status: "READY_FOR_HUMAN", failureReason: null, failureMessage: null })).toBeNull();
  });
});
