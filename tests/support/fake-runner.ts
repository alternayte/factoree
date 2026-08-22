import type {
  AgentResumeInput,
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  AgentSessionRef,
} from "~/domain/runs/agent-runner.js";

/** An AgentRunner that records what it received and returns a scripted result. */
export class FakeRunner implements AgentRunner {
  readonly runs: AgentRunInput[] = [];
  readonly resumes: Array<{ session: AgentSessionRef; input: AgentResumeInput }> = [];
  readonly cancelled: AgentSessionRef[] = [];
  private result: AgentRunResult;

  constructor(
    readonly name = "opencode",
    result: Partial<AgentRunResult> = {},
  ) {
    this.result = {
      session: { sessionId: "ses_fake", processId: "process-fake", runner: name },
      completed: true,
      exitCode: 0,
      summary: "The change is applied.",
      durationMs: 10,
      cancelled: false,
      ...result,
    };
  }

  setResult(result: Partial<AgentRunResult>): void {
    this.result = { ...this.result, ...result };
  }

  run(input: AgentRunInput): Promise<AgentRunResult> {
    this.runs.push(input);
    return Promise.resolve(this.result);
  }

  resume(session: AgentSessionRef, input: AgentResumeInput): Promise<AgentRunResult> {
    this.resumes.push({ session, input });
    return Promise.resolve(this.result);
  }

  cancel(session: AgentSessionRef): Promise<void> {
    this.cancelled.push(session);
    return Promise.resolve();
  }
}
