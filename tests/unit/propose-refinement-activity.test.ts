import { describe, expect, it } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
import { createRefinementActivities } from "~/activities/refinement.activities.js";
import type {
  ProposeRefinementActivityInput,
  ProposeRefinementActivityOutput,
} from "~/activities/refinement.activities.js";
import { RefinementEngine } from "~/domain/refinement/refinement-engine.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import type { AgentExecutionRecord, RecordAgentExecutionInput } from "~/domain/runs/agent-execution.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { FakeRunner } from "../support/fake-runner.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";

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

/** Answers the tree fingerprint and the proposal read. `trees` gives the tree of each fingerprint. */
const build = (options: { trees: string[]; proposal: string | null }) => {
  const sandbox = new FakeSandbox();
  let fingerprints = 0;
  sandbox.onExec = (command) => {
    if (command.args.includes("write-tree")) {
      const tree = options.trees[Math.min(fingerprints, options.trees.length - 1)] ?? "";
      fingerprints += 1;
      return { exitCode: 0, stdout: `${tree}\n`, stderr: "" };
    }
    if (command.file === "cat") {
      return options.proposal === null
        ? { exitCode: 1, stdout: "", stderr: "no such file" }
        : { exitCode: 0, stdout: options.proposal, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const runner = new FakeRunner("claude");
  const recorded: RecordAgentExecutionInput[] = [];
  const redactor = new Redactor();
  const activities = createRefinementActivities({
    refinement: new RefinementEngine(),
    logger: createLogger({ level: "error", redactor, sink: () => undefined }),
    agent: {
      sandbox,
      runners: new AgentRunnerRegistry([runner]),
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
  return { activities, runner, recorded };
};

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
});
