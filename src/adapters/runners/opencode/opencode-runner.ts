import type {
  AgentResumeInput,
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  AgentSessionRef,
} from "~/domain/runs/agent-runner.js";
import type { ProcessRef, ProcessSnapshot, Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { parseOpenCodeOutput } from "./output-parser.js";

export interface OpenCodeRunnerOptions {
  /** The executable inside the sandbox. Bootstrap installs it. */
  executable?: string;
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
 * SDD section 33 names OpenCodeRunner as a required adapter of the AgentRunner port. It drives
 * the opencode command line tool inside a sandbox.
 *
 * The prompt travels in the process environment, never on the command line, so it never reaches
 * a process listing. The runner never receives a Linear token or a GitHub write credential. The
 * Implementer input assembler rejects those before the runner is called. See SDD section 30.
 */
export class OpenCodeRunner implements AgentRunner {
  readonly name = "opencode";
  private readonly executable: string;
  private readonly pollIntervalMs: number;
  private readonly clock: () => number;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly activeByRun = new Map<string, string>();

  constructor(private readonly options: OpenCodeRunnerOptions) {
    this.executable = options.executable ?? "opencode";
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.clock = options.clock ?? Date.now;
  }

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
    const process = await input.sandbox.startProcess(input.ref, {
      file: this.executable,
      args: ["run", "--print-logs", "--format", "json"],
      cwd: input.workingDirectory,
      env: { ...input.environment, FACTOREE_PROMPT: input.prompt },
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

    try {
      return await this.await(live, input.timeoutMs);
    } finally {
      if (this.activeByRun.get(input.runId) === process.id) this.activeByRun.delete(input.runId);
    }
  }

  async resume(session: AgentSessionRef, input: AgentResumeInput): Promise<AgentRunResult> {
    const previous = this.sessions.get(session.processId);
    if (previous === undefined) {
      throw new Error(`OpenCodeRunner has no live sandbox for session ${session.sessionId}.`);
    }

    const process = await previous.sandbox.startProcess(previous.ref, {
      file: this.executable,
      args: ["run", "--print-logs", "--format", "json", "--session", session.sessionId],
      cwd: previous.workingDirectory,
      env: { ...previous.environment, FACTOREE_PROMPT: input.prompt },
    });

    const live: LiveSession = { ...previous, process, cancelled: false };
    this.sessions.set(process.id, live);
    // The previous process identifier is superseded by the new one. A future caller holds only
    // the new AgentSessionRef, so the old entry can never be looked up again. This entry is
    // removed here, instead of staying in the map for the life of the runner.
    if (session.processId !== process.id) this.sessions.delete(session.processId);
    return await this.await(live, input.timeoutMs);
  }

  async cancel(session: AgentSessionRef): Promise<void> {
    const live = this.sessions.get(session.processId);
    if (live === undefined) return;
    live.cancelled = true;
    await live.sandbox.cancelProcess(live.ref, live.process);
  }

  /** Polls the sandbox process until it exits, its budget ends, or Factoree cancels it. */
  private async await(live: LiveSession, timeoutMs: number): Promise<AgentRunResult> {
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
      summary: this.options.redactor.redact(parsed.summary),
      durationMs: this.clock() - startedAt,
      cancelled: options.cancelled,
    };
  }

  /**
   * Parses the process output and never throws. A parser fault must not reject the Run and
   * discard the evidence the agent already produced. This is a second, independent guard beyond
   * the parser's own defenses against a malformed line.
   */
  private safeParse(text: string): { sessionId: string | null; summary: string } {
    try {
      return parseOpenCodeOutput(text);
    } catch {
      return { sessionId: null, summary: "" };
    }
  }
}
