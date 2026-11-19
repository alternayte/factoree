import { describe, expect, it } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
import { createRefinementActivities } from "~/activities/refinement.activities.js";
import type {
  ProposeRefinementActivityInput,
  ProposeRefinementActivityOutput,
} from "~/activities/refinement.activities.js";
import { RefinementEngine } from "~/domain/refinement/refinement-engine.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import type { AgentResumeInput, AgentRunInput, AgentRunResult, AgentSessionRef } from "~/domain/runs/agent-runner.js";
import { agentSessionKey, refinerLimitCorrectionSessionKey, refinerProposalName } from "~/domain/runs/agent-session.js";
import type { AgentExecutionRecord, RecordAgentExecutionInput } from "~/domain/runs/agent-execution.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { FakeRunner } from "../support/fake-runner.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";
import { MemoryAgentSessionStore } from "../support/memory-agent-session-store.js";

const PROPOSAL = JSON.stringify({
  criteria: [
    { statement: "A failed delivery is retried.", origin: "stated", quote: "is never retried", method: "test", target: "tests/retry.test.ts" },
  ],
  questions: [],
  patterns: [],
});

const input: ProposeRefinementActivityInput = {
  runId: "run-1",
  tenantId: "tenant-1",
  productId: "product-1",
  runnerName: "claude",
  spriteId: "sprite-1",
  adapter: "fake",
  workspacePath: "/workspace",
  primaryPath: "/workspace/primary",
  workItemText: "Retry notifications\n\nA failed notification delivery is never retried.",
  goal: "Retry failed deliveries.",
  previewConfigured: false,
  statedCriteria: [],
  contextContract: "# Context Contract",
  skills: [],
  timeoutMs: 60_000,
};

/**
 * Answers the tree fingerprint and the proposal read. `trees` gives the tree of each fingerprint.
 * A function `proposal` answers per read path, so a corrected file can differ from the first.
 */
const build = (options: { trees: string[]; proposal: string | null | ((path: string) => string | null) }, runner: FakeRunner = new FakeRunner("claude")) => {
  const sandbox = new FakeSandbox();
  let fingerprints = 0;
  sandbox.onExec = (command) => {
    if (command.args.includes("write-tree")) {
      const tree = options.trees[Math.min(fingerprints, options.trees.length - 1)] ?? "";
      fingerprints += 1;
      return { exitCode: 0, stdout: `${tree}\n`, stderr: "" };
    }
    if (command.file === "cat") {
      const text = typeof options.proposal === "function" ? options.proposal(command.args[0] ?? "") : options.proposal;
      return text === null ? { exitCode: 1, stdout: "", stderr: "no such file" } : { exitCode: 0, stdout: text, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const sessions = new MemoryAgentSessionStore();
  const recorded: RecordAgentExecutionInput[] = [];
  const redactor = new Redactor();
  const activities = createRefinementActivities({
    refinement: new RefinementEngine(),
    logger: createLogger({ level: "error", redactor, sink: () => undefined }),
    agent: {
      sandbox,
      runners: new AgentRunnerRegistry([runner]),
      sessions,
      executions: {
        record(entry: RecordAgentExecutionInput): Promise<AgentExecutionRecord> {
          recorded.push(entry);
          return Promise.resolve({ ...entry, id: "exec-1", createdAt: new Date() });
        },
        listForRun: () => Promise.resolve([]),
      },
      secrets: new MemorySecretStore(),
      redactor,
    },
  });
  return { activities, runner, recorded, sandbox, sessions };
};

/** A proposal with `count` stated criteria that quote the ticket. */
const proposalOf = (count: number): string =>
  JSON.stringify({
    criteria: Array.from({ length: count }, (_, index) => ({
      statement: `A failed delivery is retried, case ${String(index)}.`,
      origin: "stated",
      quote: "is never retried",
      method: "test",
      target: "tests/retry.test.ts",
    })),
    questions: [],
    patterns: [],
  });

const run = (
  activities: ReturnType<typeof build>["activities"],
  value: ProposeRefinementActivityInput,
): Promise<ProposeRefinementActivityOutput> =>
  new MockActivityEnvironment().run((entry: ProposeRefinementActivityInput) => activities.proposeRefinement(entry), value);

describe("the proposeRefinement activity (docs/specs/refiner-agent.md)", () => {
  it("returns the gated proposal of a fresh refiner session and records its execution", async () => {
    const { activities, runner, recorded } = build({ trees: ["a".repeat(40)], proposal: PROPOSAL });
    const output: ProposeRefinementActivityOutput = await new MockActivityEnvironment().run((value: ProposeRefinementActivityInput) => activities.proposeRefinement(value), input);
    expect(output.status).toBe("proposed");
    expect(output.accepted.map((criterion) => criterion.source)).toEqual(["ticket:quote"]);
    expect(runner.runs[0]?.role).toBe("refiner");
    expect(recorded[0]?.role).toBe("refiner");
  });

  it("reports worktree_changed when the refiner changed a file of the primary worktree", async () => {
    const { activities } = build({ trees: ["a".repeat(40), "b".repeat(40)], proposal: PROPOSAL });
    const output: ProposeRefinementActivityOutput = await new MockActivityEnvironment().run((value: ProposeRefinementActivityInput) => activities.proposeRefinement(value), input);
    expect(output.status).toBe("worktree_changed");
    expect(output.reason).toContain("b".repeat(40));
  });

  it("reports unavailable when the refiner wrote no proposal, after one reminder", async () => {
    const { activities, runner } = build({ trees: ["a".repeat(40)], proposal: null });
    const output: ProposeRefinementActivityOutput = await new MockActivityEnvironment().run((value: ProposeRefinementActivityInput) => activities.proposeRefinement(value), input);
    expect(output.status).toBe("unavailable");
    expect(runner.resumes).toHaveLength(1);
  });

  it("reports unavailable for a proposal that does not match the schema", async () => {
    const { activities } = build({ trees: ["a".repeat(40)], proposal: "{\"criteria\": 1}" });
    const output: ProposeRefinementActivityOutput = await new MockActivityEnvironment().run((value: ProposeRefinementActivityInput) => activities.proposeRefinement(value), input);
    expect(output.status).toBe("unavailable");
  });

  // Issue #39, DI-21.66.
  it("states the criteria limit of the Product in the prompt", async () => {
    const { activities, runner } = build({ trees: ["a".repeat(40)], proposal: PROPOSAL });
    await run(activities, { ...input, criteriaLimit: 12 });
    expect(runner.runs[0]?.prompt).toContain("Propose at most 12 criteria and at most 5 questions.");
  });

  it("resumes the session once to correct a proposal over the criteria limit, and takes the corrected file", async () => {
    const { activities, runner } = build({
      trees: ["a".repeat(40)],
      proposal: (path) => (path.endsWith("proposal-corrected.json") ? proposalOf(3) : proposalOf(4)),
    });
    const output = await run(activities, { ...input, criteriaLimit: 3 });
    expect(output.status).toBe("proposed");
    expect(output.accepted).toHaveLength(3);
    expect(runner.resumes).toHaveLength(1);
    expect(runner.resumes[0]?.input.prompt).toContain("4 criteria. The limit is 3.");
    expect(runner.resumes[0]?.input.prompt).toContain("/workspace/refinement/proposal-corrected.json");
    expect(runner.runs).toHaveLength(1);
  });

  it("starts one fresh session when the session cannot be resumed", async () => {
    const { activities, runner, recorded } = build({
      trees: ["a".repeat(40)],
      // Only the fresh session writes the corrected file.
      proposal: (path) => (!path.endsWith("corrected.json") ? proposalOf(4) : runner.runs.length > 1 ? proposalOf(2) : null),
    });
    runner.setResult({ session: { sessionId: "process-fake", processId: "process-fake", runner: "claude" } });
    const output = await run(activities, { ...input, criteriaLimit: 3 });
    expect(output.status).toBe("proposed");
    expect(runner.resumes).toHaveLength(0);
    expect(runner.runs).toHaveLength(2);
    expect(runner.runs[1]?.promptVersion).toBe("refiner@12+refiner-limit-correction@1");
    expect(recorded.map((entry) => entry.idempotencyKey)).toContain("run:run-1:refiner:limit-correction");
  });

  it("fails with a message for the human when the proposal stays over the limit", async () => {
    const { activities, runner } = build({ trees: ["a".repeat(40)], proposal: proposalOf(4) });
    const output = await run(activities, { ...input, criteriaLimit: 3 });
    expect(output.status).toBe("unavailable");
    expect(runner.resumes).toHaveLength(1);
    expect(output.message).toBe(
      "The Work Item needs more than 3 acceptance criteria, the limit of this product. Split it into smaller issues, " +
        "or raise the refiner criteria limit on the product page. Factoree published nothing.",
    );
  });

  it("asks for no correction for a schema fault other than a limit", async () => {
    const { activities, runner } = build({ trees: ["a".repeat(40)], proposal: "{\"criteria\": 1}" });
    const output = await run(activities, input);
    expect(output.status).toBe("unavailable");
    expect(output.message).toBeUndefined();
    expect(runner.resumes).toHaveLength(0);
  });
});

describe("the proposeRefinement activity, limit correction under an outage (docs/specs/provider-unreachable.md, plan section 8)", () => {
  const OUTAGE = "getaddrinfo EAI_AGAIN api.example.test";
  const unreachable = (result: AgentRunResult): AgentRunResult => ({
    ...result,
    completed: false,
    exitCode: 1,
    outcome: "unreachable",
    failureKind: "PROVIDER_UNREACHABLE",
    summary: OUTAGE,
  });
  /** A refiner whose CLI named no session, so a correction cannot resume it. */
  const processNamed = { sessionId: "process-fake", processId: "process-fake", runner: "claude" };

  // The workflow carries these as 0, 1, 2 and as after-hang with no number, then 3 and 4. A retry
  // number alone makes the session fresh, and `afterHang` alone is the one session after a hang.
  const variants: Array<{ label: string; afterHang?: boolean; unreachableRetry?: number }> = [
    { label: "retry 1", unreachableRetry: 1 },
    { label: "retry 2", unreachableRetry: 2 },
    { label: "after a hang", afterHang: true },
    { label: "after a hang, retry 3", afterHang: true, unreachableRetry: 3 },
    { label: "after a hang, retry 4", afterHang: true, unreachableRetry: 4 },
    { label: "after a hang flag with retry 1", afterHang: true, unreachableRetry: 1 },
  ];
  const effective = (variant: { afterHang?: boolean; unreachableRetry?: number }): { afterHang: boolean; retry: number } => {
    const retry = variant.unreachableRetry ?? 0;
    return { afterHang: variant.afterHang === true || retry > 0, retry };
  };
  const inputOf = (variant: { afterHang?: boolean; unreachableRetry?: number }): ProposeRefinementActivityInput => ({
    ...input,
    criteriaLimit: 3,
    ...(variant.afterHang === true ? { afterHang: true } : {}),
    ...(variant.unreachableRetry === undefined ? {} : { unreachableRetry: variant.unreachableRetry }),
  });

  it.each(variants)("starts the fresh correction under its own key and file, $label", async (variant) => {
    const { afterHang, retry } = effective(variant);
    const base = refinerProposalName(afterHang, retry);
    const runner = new FakeRunner("claude", { session: processNamed });
    const { activities, recorded, sessions } = build(
      {
        trees: ["a".repeat(40)],
        // Only the fresh session writes the corrected file.
        proposal: (path) => (!path.endsWith("-corrected.json") ? proposalOf(4) : runner.runs.length > 1 ? proposalOf(2) : null),
      },
      runner,
    );

    const output = await run(activities, inputOf(variant));

    expect(output.status).toBe("proposed");
    expect(runner.runs).toHaveLength(2);
    // The first session and the correction name files of this retry, and no file of another.
    expect(runner.runs[0]!.prompt).toContain(`/workspace/refinement/${base}.json`);
    expect(runner.runs[1]!.prompt).toContain(`/workspace/refinement/${base}-corrected.json`);
    expect(runner.runs[1]!.prompt).not.toContain(`/workspace/refinement/${base}.json`);
    expect(runner.runs[1]!.prompt).not.toContain("/workspace/refinement/proposal-corrected.json");
    const first = agentSessionKey("run-1", "refiner", null, afterHang, retry);
    const correction = refinerLimitCorrectionSessionKey("run-1", afterHang, retry);
    expect(correction).not.toBe(first);
    expect(correction).not.toBe(refinerLimitCorrectionSessionKey("run-1", false, 0));
    expect(recorded.map((entry) => entry.idempotencyKey)).toEqual([correction, first]);
    expect(sessions.rows.map((row) => row.idempotencyKey)).toEqual([first, correction]);
  });

  it("gives the correction of every variant a key and a file that no other variant uses", () => {
    const all = [{ label: "first session" } as { label: string; afterHang?: boolean; unreachableRetry?: number }, ...variants.slice(0, 5)].map(effective);
    expect(new Set(all.map(({ afterHang, retry }) => refinerLimitCorrectionSessionKey("run-1", afterHang, retry))).size).toBe(all.length);
    expect(new Set(all.map(({ afterHang, retry }) => `${refinerProposalName(afterHang, retry)}-corrected.json`)).size).toBe(all.length);
  });

  it.each(variants)("resumes the session for the correction in a file of its own, $label", async (variant) => {
    const { afterHang, retry } = effective(variant);
    const base = refinerProposalName(afterHang, retry);
    const { activities, runner, recorded, sessions } = build({
      trees: ["a".repeat(40)],
      proposal: (path) => (path.endsWith(`${base}-corrected.json`) ? proposalOf(3) : proposalOf(4)),
    });

    const output = await run(activities, inputOf(variant));

    expect(output.status).toBe("proposed");
    expect(output.accepted).toHaveLength(3);
    expect(runner.runs).toHaveLength(1);
    expect(runner.resumes[0]!.input.prompt).toContain(`/workspace/refinement/${base}-corrected.json`);
    // A resume is the session of the first, so it writes no row of the correction key.
    const first = agentSessionKey("run-1", "refiner", null, afterHang, retry);
    expect(recorded.map((entry) => entry.idempotencyKey)).toEqual([first]);
    expect(sessions.rows.map((row) => row.idempotencyKey)).toEqual([first]);
  });

  it.each(variants)("reports the outage of the correction session itself, and starts no later fresh session, $label", async (variant) => {
    const { afterHang, retry } = effective(variant);
    const base = refinerProposalName(afterHang, retry);
    class UnreachableCorrectionRunner extends FakeRunner {
      override async run(runInput: AgentRunInput): Promise<AgentRunResult> {
        const result = await super.run(runInput);
        return this.runs.length === 1 ? result : unreachable(result);
      }
    }
    const runner = new UnreachableCorrectionRunner("claude", { session: processNamed });
    const { activities, recorded, sessions } = build(
      {
        trees: ["a".repeat(40)],
        // The fresh session leaves a corrected file even so. An outage still ends the pass as
        // unavailable, so neither proposal is taken as the outcome of a good correction.
        proposal: (path) => (!path.endsWith(`${base}-corrected.json`) ? proposalOf(4) : runner.runs.length > 1 ? proposalOf(2) : null),
      },
      runner,
    );

    const output = await run(activities, inputOf(variant));

    expect(output.status).toBe("unavailable");
    expect(output.providerUnreachable).toEqual({ summary: OUTAGE });
    expect(output.accepted).toEqual([]);
    expect(output.decisions).toEqual([]);
    expect(output.hang).toBeNull();
    // The first session and the one fresh correction. No third session, no resume.
    expect(runner.runs).toHaveLength(2);
    expect(runner.resumes).toHaveLength(0);
    const first = agentSessionKey("run-1", "refiner", null, afterHang, retry);
    const correction = refinerLimitCorrectionSessionKey("run-1", afterHang, retry);
    expect(recorded.map((entry) => entry.idempotencyKey)).toEqual([correction, first]);
    expect(sessions.rows.map((row) => [row.idempotencyKey, row.outcome])).toEqual([
      [first, "finished"],
      [correction, "unreachable"],
    ]);
  });

  it("reports the outage of a correction resume, and starts no fresh session", async () => {
    class UnreachableResumeRunner extends FakeRunner {
      override async resume(session: AgentSessionRef, resumeInput: AgentResumeInput): Promise<AgentRunResult> {
        return unreachable(await super.resume(session, resumeInput));
      }
    }
    const runner = new UnreachableResumeRunner("claude");
    const { activities } = build(
      { trees: ["a".repeat(40)], proposal: (path) => (path.endsWith("-corrected.json") && runner.runs.length > 1 ? proposalOf(2) : path.endsWith("-corrected.json") ? null : proposalOf(4)) },
      runner,
    );

    const output = await run(activities, { ...input, criteriaLimit: 3, unreachableRetry: 1 });

    expect(output.status).toBe("unavailable");
    expect(output.providerUnreachable).toEqual({ summary: OUTAGE });
    expect(runner.resumes).toHaveLength(1);
    expect(runner.runs).toHaveLength(1);
  });
});

describe("the proposeRefinement activity, targets and edges (docs/specs/change-sets.md, DI-21.139)", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const proposal = JSON.stringify({
    ...JSON.parse(PROPOSAL),
    targets: [{ repository: "acme/web", file: "src/api.ts", line: 12, reason: "it calls the renamed endpoint" }],
    edges: [{ provider: "acme/api", consumer: "acme/web", file: "src/api.ts", line: 12 }],
  });
  const siblingInput: ProposeRefinementActivityInput = {
    ...input,
    primaryRepository: "acme/api",
    siblings: [{ repository: "acme/web", path: "/workspace/siblings/acme/web", commitSha: SHA }],
    targetsOpen: true,
  };

  it("reads each cited line in its clone and returns the target the gate accepted", async () => {
    const { activities, sandbox, runner } = build({ trees: ["a".repeat(40)], proposal });
    const base = sandbox.onExec!;
    sandbox.onExec = (command) =>
      command.file === "sh" && command.args[1] === "/workspace/siblings/acme/web" && command.args[2] === "src/api.ts" && command.args[3] === "12"
        ? { exitCode: 0, stdout: "fetch('/v1/orders')\n", stderr: "" }
        : base(command);
    const output = await run(activities, siblingInput);

    expect(output.status).toBe("proposed");
    expect(output.addedTargets?.map((target) => [target.repository, target.commitSha])).toEqual([["acme/web", SHA]]);
    expect(output.edges).toEqual([{ provider: "acme/api", consumer: "acme/web", file: "src/api.ts", line: 12 }]);
    expect(runner.runs[0]?.prompt).toContain(`- acme/web: /workspace/siblings/acme/web at ${SHA}`);
  });

  it("adds nothing when the run cannot add a target", async () => {
    const { activities } = build({ trees: ["a".repeat(40)], proposal });
    const output = await run(activities, { ...siblingInput, targetsOpen: false });
    expect(output.addedTargets).toBeUndefined();
    expect(output.decisions.some((decision) => decision.kind === "target")).toBe(false);
  });
});
