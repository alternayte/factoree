import type {
  AgentCancelOutcome,
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
  /** While this promise is pending, `run` does not resolve. It models a long agent run. */
  private hold: Promise<void> | null = null;
  private live: AgentSessionRef | null = null;
  /** The delay before the session registers. It models the start of the sandbox process. */
  private startDelayMs = 0;
  /** The outcome the next `cancel` call reports. A test sets it to model a remote worker. */
  private cancelOutcome: AgentCancelOutcome = "cancelled";

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
      failureLog: null,
      outcome: "finished",
      silenceLimitMs: 600_000,
      usage: null,
      model: null,
      effort: null,
      ...result,
    };
  }

  setResult(result: Partial<AgentRunResult>): void {
    this.result = { ...this.result, ...result };
  }

  /** Delays the registration of the session, the way a real process start does. */
  delayStart(milliseconds: number): void {
    this.startDelayMs = milliseconds;
  }

  /** Holds every later `run` open until the returned function is called. */
  holdRun(): () => void {
    let release = (): void => undefined;
    this.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  /** The live session of one Run. `OpenCodeRunner` offers the same lookup. */
  activeSession(runId: string): AgentSessionRef | undefined {
    const started = this.runs.some((entry) => entry.runId === runId);
    return started ? (this.live ?? undefined) : undefined;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.runs.push(input);
    if (this.startDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.startDelayMs));
    }
    this.live = this.result.session;
    await this.hold;
    this.live = null;
    return this.result;
  }

  resume(session: AgentSessionRef, input: AgentResumeInput): Promise<AgentRunResult> {
    this.resumes.push({ session, input });
    return Promise.resolve(this.result);
  }

  /** Sets the outcome the next `cancel` call reports. Default is "cancelled". */
  setCancelOutcome(outcome: AgentCancelOutcome): void {
    this.cancelOutcome = outcome;
  }

  cancel(session: AgentSessionRef): Promise<AgentCancelOutcome> {
    this.cancelled.push(session);
    return Promise.resolve(this.cancelOutcome);
  }
}
