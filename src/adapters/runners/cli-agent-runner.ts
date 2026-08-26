import type {
  AgentCancelOutcome,
  AgentResumeInput,
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  AgentSessionRef,
} from "~/domain/runs/agent-runner.js";
import type { ProcessRef, ProcessSnapshot, Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import type { Redactor } from "~/telemetry/redaction.js";

/** One command line a runner starts inside the sandbox. */
export interface CliAgentCommand {
  file: string;
  args: string[];
  /** The values this command adds to the process environment. The prompt travels here. */
  env: Record<string, string>;
}

export interface CliAgentParse {
  sessionId: string | null;
  summary: string;
}

export interface CliAgentRunnerOptions {
  redactor: Redactor;
  pollIntervalMs?: number;
  clock?: () => number;
}

interface LiveSession {
  sandbox: Sandbox;
  ref: SandboxRef;
  process: ProcessRef;
  workingDirectory: string;
  environment: Record<string, string>;
  cancelled: boolean;
}

/**
 * The shared body of every command-line agent runner. SDD section 33 names two required
 * adapters, and both drive a command-line tool inside a sandbox. The poll loop, the budget, the
 * cancel path, and the result build are therefore one implementation. A subclass supplies only
 * the start command, the resume command, and the parser.
 *
 * The prompt travels in the process environment, never on the command line, so it never reaches
 * a process listing. A runner never receives a Linear token or a GitHub write credential. The
 * Implementer input assembler rejects those before a runner is called. See SDD section 30.
 */
export abstract class CliAgentRunner implements AgentRunner {
  abstract readonly name: string;
  private readonly pollIntervalMs: number;
  private readonly clock: () => number;
  // Every session of one Run, by process id. A Temporal activity retry can present an old
  // `AgentSessionRef`, so an entry must live until the Run itself ends. `releaseRun` disposes
  // every entry of one Run, which bounds the map by the number of Runs in flight.
  private readonly sessions = new Map<string, LiveSession>();
  private readonly activeByRun = new Map<string, string>();
  /** The process ids one Run created, so `releaseRun` can dispose all of them. */
  private readonly processesByRun = new Map<string, Set<string>>();

  constructor(protected readonly cliOptions: CliAgentRunnerOptions) {
    this.pollIntervalMs = cliOptions.pollIntervalMs ?? 1_000;
    this.clock = cliOptions.clock ?? Date.now;
  }

  /** The command that starts a new session with the given prompt. */
  protected abstract startCommand(prompt: string): CliAgentCommand;

  /** The command that continues an existing session with a further prompt. */
  protected abstract resumeCommand(sessionId: string, prompt: string): CliAgentCommand;

  /** Reads the output of the tool. An implementation must never throw. */
  protected abstract parseOutput(text: string): CliAgentParse;

  /**
   * Returns the session reference for a run that is still active, as soon as the sandbox
   * process starts. A caller uses this to cancel a run before it resolves, without a private
   * cast into runner state. It returns undefined once the run has no live process for the
   * given run identifier.
   *
   * A resumed run has no equivalent lookup, because `AgentResumeInput` carries no run
   * identifier. A caller that resumes a session already holds the `AgentSessionRef` it needs
   * to cancel that resumed run directly.
   */
  activeSession(runId: string): AgentSessionRef | undefined {
    const processId = this.activeByRun.get(runId);
    if (processId === undefined) return undefined;
    const live = this.sessions.get(processId);
    if (live === undefined) return undefined;
    return { sessionId: live.process.id, processId: live.process.id, runner: this.name };
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const command = this.startCommand(input.prompt);
    const process = await input.sandbox.startProcess(input.ref, {
      file: command.file,
      args: command.args,
      cwd: input.workingDirectory,
      env: { ...input.environment, ...command.env },
    });

    const live: LiveSession = {
      sandbox: input.sandbox,
      ref: input.ref,
      process,
      workingDirectory: input.workingDirectory,
      environment: input.environment,
      cancelled: false,
    };
    this.sessions.set(process.id, live);
    this.activeByRun.set(input.runId, process.id);
    this.trackProcess(input.runId, process.id);

    try {
      return await this.awaitProcess(live, input.timeoutMs);
    } finally {
      if (this.activeByRun.get(input.runId) === process.id) this.activeByRun.delete(input.runId);
    }
  }

  async resume(session: AgentSessionRef, input: AgentResumeInput): Promise<AgentRunResult> {
    const previous = this.sessions.get(session.processId);
    if (previous === undefined) {
      throw new Error(`${this.name} has no live sandbox for session ${session.sessionId}.`);
    }

    const command = this.resumeCommand(session.sessionId, input.prompt);
    const process = await previous.sandbox.startProcess(previous.ref, {
      file: command.file,
      args: command.args,
      cwd: previous.workingDirectory,
      env: { ...previous.environment, ...command.env },
    });

    const live: LiveSession = { ...previous, process, cancelled: false };
    this.sessions.set(process.id, live);
    const owner = this.runOfProcess(session.processId);
    if (owner !== undefined) this.trackProcess(owner, process.id);
    return await this.awaitProcess(live, input.timeoutMs);
  }

  async cancel(session: AgentSessionRef): Promise<AgentCancelOutcome> {
    const live = this.sessions.get(session.processId);
    if (live === undefined) return "no-live-session";
    live.cancelled = true;
    await live.sandbox.cancelProcess(live.ref, live.process);
    return "cancelled";
  }

  /**
   * Disposes every session of one Run. Call it once the Run reaches a terminal state. A later
   * call with the same run id is a no-op, so a Temporal activity retry is safe.
   */
  releaseRun(runId: string): void {
    const processes = this.processesByRun.get(runId);
    if (processes !== undefined) {
      for (const processId of processes) this.sessions.delete(processId);
      this.processesByRun.delete(runId);
    }
    this.activeByRun.delete(runId);
  }

  /** The number of sessions this runner still holds. A test uses it to prove the bound. */
  retainedSessionCount(): number {
    return this.sessions.size;
  }

  private trackProcess(runId: string, processId: string): void {
    const existing = this.processesByRun.get(runId);
    if (existing === undefined) this.processesByRun.set(runId, new Set([processId]));
    else existing.add(processId);
  }

  private runOfProcess(processId: string): string | undefined {
    for (const [runId, processes] of this.processesByRun) {
      if (processes.has(processId)) return runId;
    }
    return undefined;
  }

  /** Polls the sandbox process until it exits, its budget ends, or Factoree cancels it. */
  private async awaitProcess(live: LiveSession, timeoutMs: number): Promise<AgentRunResult> {
    const startedAt = this.clock();
    const deadline = startedAt + timeoutMs;

    for (;;) {
      const snapshot = await live.sandbox.readProcess(live.ref, live.process);

      if (!snapshot.running) {
        return this.buildResult(live, snapshot, startedAt, {
          cancelled: live.cancelled,
          fallbackExitCode: 1,
        });
      }

      if (this.clock() >= deadline) {
        // On timeout Factoree cancels the active process and preserves the evidence it already
        // produced. See SDD section 50.
        await live.sandbox.cancelProcess(live.ref, live.process);
        const final = await live.sandbox.readProcess(live.ref, live.process);
        return this.buildResult(live, final, startedAt, {
          cancelled: true,
          completed: false,
          fallbackExitCode: 124,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  /**
   * Builds the final result from one process snapshot. It reads the output through a guarded
   * parse, so a malformed event never rejects the Run and never discards the evidence the agent
   * already produced. `completed`, when given, wins over the exit code check. This carries the
   * timeout branch, where the exit code alone does not say whether the Run finished its work.
   */
  private buildResult(
    live: LiveSession,
    snapshot: ProcessSnapshot,
    startedAt: number,
    options: { cancelled: boolean; completed?: boolean; fallbackExitCode: number },
  ): AgentRunResult {
    const parsed = this.safeParse(`${snapshot.stdout}\n${snapshot.stderr}`);
    const exitCode = snapshot.exitCode ?? options.fallbackExitCode;
    const completed = options.completed ?? (exitCode === 0 && !options.cancelled);
    return {
      session: {
        sessionId: parsed.sessionId ?? live.process.id,
        processId: live.process.id,
        runner: this.name,
      },
      completed,
      exitCode,
      summary: this.cliOptions.redactor.redact(parsed.summary),
      durationMs: this.clock() - startedAt,
      cancelled: options.cancelled,
    };
  }

  /**
   * Parses the process output and never throws. A parser fault must not reject the Run and
   * discard the evidence the agent already produced. This is a second, independent guard beyond
   * the parser's own defenses against a malformed line.
   */
  private safeParse(text: string): CliAgentParse {
    try {
      return this.parseOutput(text);
    } catch {
      return { sessionId: null, summary: "" };
    }
  }
}
