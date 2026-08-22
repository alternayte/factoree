import type {
  AgentResumeInput,
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  AgentSessionRef,
} from "~/domain/runs/agent-runner.js";
import type { ProcessRef, Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
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
        const parsed = parseOpenCodeOutput(`${snapshot.stdout}\n${snapshot.stderr}`);
        const exitCode = snapshot.exitCode ?? 1;
        return {
          session: {
            sessionId: parsed.sessionId ?? live.process.id,
            processId: live.process.id,
            runner: this.name,
          },
          completed: exitCode === 0 && !live.cancelled,
          exitCode,
          summary: this.options.redactor.redact(parsed.summary),
          durationMs: this.clock() - startedAt,
          cancelled: live.cancelled,
        };
      }

      if (this.clock() >= deadline) {
        // On timeout Factoree cancels the active process and preserves the evidence it already
        // produced. See SDD section 50.
        await live.sandbox.cancelProcess(live.ref, live.process);
        const final = await live.sandbox.readProcess(live.ref, live.process);
        const parsed = parseOpenCodeOutput(`${final.stdout}\n${final.stderr}`);
        return {
          session: {
            sessionId: parsed.sessionId ?? live.process.id,
            processId: live.process.id,
            runner: this.name,
          },
          completed: false,
          exitCode: final.exitCode ?? 124,
          summary: this.options.redactor.redact(parsed.summary),
          durationMs: this.clock() - startedAt,
          cancelled: true,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }
}
