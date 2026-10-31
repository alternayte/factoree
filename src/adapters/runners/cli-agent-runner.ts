import { randomUUID } from "node:crypto";
import type {
  AgentCancelOutcome,
  AgentRole,
  AgentResumeInput,
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  AgentSessionRef,
} from "~/domain/runs/agent-runner.js";
import type { ProcessRef, ProcessSnapshot, Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { buildRetainedLog } from "~/domain/runs/retained-log.js";

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
  /**
   * The failure the agent itself reported, when its output carries one. A CLI writes an error
   * event and then an ordinary shutdown line, so the last line of the output names nothing an
   * operator can act on. `buildResult` puts this value in the summary of a Run that did not
   * finish, so the Proof Pack states the real cause instead of the shutdown line.
   */
  errorMessage?: string;
}

export interface CliAgentRunnerOptions {
  redactor: Redactor;
  pollIntervalMs?: number;
  clock?: () => number;
  /**
   * How long a session may write nothing before Factoree ends it. It never outlives the Run
   * budget. A test lowers it.
   */
  idleTimeoutMs?: number;
}

/**
 * The default idle deadline of an agent session. An agent writes an event for every step and
 * every tool call, so ten minutes of complete silence means it stopped working, whatever the
 * process state says.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

interface LiveSession {
  sandbox: Sandbox;
  ref: SandboxRef;
  process: ProcessRef;
  workingDirectory: string;
  repositoryPath?: string;
  environment: Record<string, string>;
  /** The role of the session. A resume keeps the settings of the role that started it. */
  role: AgentRole;
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
  private readonly idleTimeoutMs: number;
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
    this.idleTimeoutMs = cliOptions.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.clock = cliOptions.clock ?? Date.now;
  }

  /** The command that starts a new session with the given prompt. */
  /**
   * `promptFile` names the file that holds the prompt, and `repositoryPath` the repository the
   * session configures itself from. The prompt is a file because Linux carries at most 131072
   * bytes in one environment value, and a real Reviewer prompt measured 202351 bytes.
   */
  protected abstract startCommand(promptFile: string, repositoryPath: string | undefined, role: AgentRole): CliAgentCommand;

  /** The command that continues an existing session with a further prompt. */
  protected abstract resumeCommand(
    sessionId: string,
    promptFile: string,
    repositoryPath: string | undefined,
    role: AgentRole,
  ): CliAgentCommand;

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
    const promptFile = await this.writePrompt(input.sandbox, input.ref, input.prompt);
    const command = this.startCommand(promptFile, input.repositoryPath, input.role);
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
      ...(input.repositoryPath === undefined ? {} : { repositoryPath: input.repositoryPath }),
      environment: input.environment,
      role: input.role,
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

    const promptFile = await this.writePrompt(previous.sandbox, previous.ref, input.prompt);
    const command = this.resumeCommand(session.sessionId, promptFile, previous.repositoryPath, previous.role);
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

  /**
   * Writes one prompt into the sandbox and returns its path.
   *
   * The file sits beside the process records of Factoree, outside every checkout, so it never
   * reaches a patch and never reads as repository content. SDD section 30 forbids a prompt on a
   * command line, and a file honours that: the content stays out of the process listing.
   */
  private async writePrompt(sandbox: Sandbox, ref: SandboxRef, prompt: string): Promise<string> {
    const path = `${ref.workspacePath}/.factoree/prompt/${randomUUID()}.txt`;
    await sandbox.writeFile(ref, path, prompt);
    return path;
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

  /**
   * Polls the sandbox process until it exits, its budget ends, it stops producing output, or
   * Factoree cancels it.
   *
   * The idle deadline exists because an agent can wait for ever on a connection that will never
   * answer. A sandbox that pauses drops every open connection, and a CLI that sets no timeout of
   * its own then sleeps until the Run budget ends, which wastes the whole budget on a session
   * that stopped working minutes after it started. Output is the signal: a working agent writes
   * events continuously.
   */
  private async awaitProcess(live: LiveSession, timeoutMs: number): Promise<AgentRunResult> {
    const startedAt = this.clock();
    const deadline = startedAt + timeoutMs;
    // The idle deadline never outlives the budget, so a short budget keeps its own meaning.
    const idleLimitMs = Math.min(this.idleTimeoutMs, timeoutMs);
    // The comparison is on the text, not on its length. Two events of one shape carry the same
    // number of characters, and a length test would read a working agent as a silent one.
    let lastOutput: string | null = null;
    let lastOutputAt = startedAt;

    for (;;) {
      const snapshot = await live.sandbox.readProcess(live.ref, live.process);

      const output = `${snapshot.stdout}\n${snapshot.stderr}`;
      if (output !== lastOutput) {
        lastOutput = output;
        lastOutputAt = this.clock();
      }

      if (!snapshot.running) {
        return this.buildResult(live, snapshot, startedAt, {
          cancelled: live.cancelled,
          fallbackExitCode: 1,
        });
      }

      if (snapshot.running && this.clock() - lastOutputAt >= idleLimitMs) {
        // The session produced nothing for the whole idle window. Factoree ends it here, so the
        // rest of the Run budget stays available to a repair attempt. The evidence it already
        // produced is preserved, the same as on a budget timeout.
        await live.sandbox.cancelProcess(live.ref, live.process);
        const final = await live.sandbox.readProcess(live.ref, live.process);
        const result = this.buildResult(live, final, startedAt, {
          cancelled: true,
          completed: false,
          fallbackExitCode: 124,
        });
        return {
          ...result,
          summary:
            `The ${this.name} session wrote nothing for ${Math.round(idleLimitMs / 1000)} seconds, so ` +
            `Factoree ended it. ${result.summary}`.trim(),
        };
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
    // A Run that did not finish must state why. The agent's own error outranks its last output
    // line, and it outranks a partial answer, because the partial answer hides the fault.
    const summary =
      !completed && parsed.errorMessage !== undefined && parsed.errorMessage.length > 0
        ? parsed.errorMessage
        : parsed.summary;
    return {
      session: {
        sessionId: parsed.sessionId ?? live.process.id,
        processId: live.process.id,
        runner: this.name,
      },
      completed,
      exitCode,
      summary: this.cliOptions.redactor.redact(summary),
      // Only a failure retains a log. A finished session is described by its summary alone.
      failureLog: completed
        ? null
        : buildRetainedLog(this.cliOptions.redactor, snapshot.stdout, snapshot.stderr),
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
