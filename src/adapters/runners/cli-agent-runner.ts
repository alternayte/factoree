import { randomUUID } from "node:crypto";
import { AgentSessionUnavailableError } from "~/domain/runs/agent-runner.js";
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
import type { AgentSessionOutcome, AgentSessionUsage } from "~/domain/runs/agent-session.js";

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

/** What a runner reads after one process ends, to learn the usage of that invocation. */
export interface CliUsageContext {
  sandbox: Sandbox;
  ref: SandboxRef;
  /** The directory the session configured itself from: the repository, or the working directory. */
  directory: string;
  /** The environment the session ran with, without the command values. */
  environment: Record<string, string>;
  role: AgentRole;
  /** The settings the session ran with. */
  settings: AgentSessionSettings;
  /** The session identifier the output named, or null. */
  sessionId: string | null;
  /** The whole output of the process, stdout then stderr. */
  output: string;
  /**
   * The model calls an earlier invocation of the same CLI session already reported. A resume
   * shares the set, so each invocation reports only its own calls.
   */
  counted: Set<string>;
}

export interface CliUsageReading {
  usage: AgentSessionUsage | null;
  model: string | null;
  /** docs/specs/skill-registry.md. The input of every tool call of the invocation, as JSON. */
  toolInputs?: string[];
}

/**
 * docs/specs/release-0-1-0.md. The settings of one agent session. The Product holds the model,
 * the effort of each role and the silence limit, and the worker reads them when a session starts.
 * A resume keeps the settings of the session it continues.
 */
export interface AgentSessionSettings {
  /** `provider/model`, or null for the CLI default. */
  model: string | null;
  /** The reasoning effort of the role, or null for the CLI default. */
  effort: string | null;
  silenceLimitMs: number;
  /** The CLI inside the sandbox, or null for the runner default. */
  executable: string | null;
}

export interface CliAgentRunnerOptions {
  redactor: Redactor;
  /**
   * Reads the settings of a new session. Without it the runner uses its constructor options,
   * which is what a test does.
   */
  settingsFor?: (input: AgentRunInput, runner: string) => Promise<AgentSessionSettings>;
  pollIntervalMs?: number;
  clock?: () => number;
  /**
   * docs/specs/agent-session-usage-and-hangs.md. The silence limit: how long a session may write
   * no new output before Factoree reports it hung and stops it. `AGENT_SILENCE_MINUTES` sets it.
   * A test lowers it.
   */
  silenceLimitMs?: number;
}

/**
 * The default silence limit of an agent session. At `max` effort a model can think for minutes
 * with no output, so the limit is generous. Ten minutes of complete silence means the session
 * stopped working, whatever the process state says.
 */
export const DEFAULT_SILENCE_LIMIT_MS = 10 * 60 * 1_000;

/** The deadline of the usage read after a session. A CLI that does not answer costs no more. */
export const USAGE_READ_TIMEOUT_MS = 60_000;

interface LiveSession {
  sandbox: Sandbox;
  ref: SandboxRef;
  process: ProcessRef;
  workingDirectory: string;
  repositoryPath?: string;
  environment: Record<string, string>;
  /** The role of the session. A resume keeps the settings of the role that started it. */
  role: AgentRole;
  settings: AgentSessionSettings;
  cancelled: boolean;
  /** The model calls of this CLI session that an earlier invocation already reported. */
  counted: Set<string>;
  /**
   * The CLI session a resume continues. A resumed CLI can write no session event, and the usage
   * read and the result still need the identifier.
   */
  cliSessionId: string | null;
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
  private readonly silenceLimitMs: number;
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
    this.silenceLimitMs = cliOptions.silenceLimitMs ?? DEFAULT_SILENCE_LIMIT_MS;
    this.clock = cliOptions.clock ?? Date.now;
  }

  /** The command that starts a new session with the given prompt. */
  /**
   * `promptFile` names the file that holds the prompt, and `repositoryPath` the repository the
   * session configures itself from. The prompt is a file because Linux carries at most 131072
   * bytes in one environment value, and a real Reviewer prompt measured 202351 bytes.
   */
  protected abstract startCommand(
    promptFile: string,
    repositoryPath: string | undefined,
    settings: AgentSessionSettings,
  ): CliAgentCommand;

  /** The command that continues an existing session with a further prompt. */
  protected abstract resumeCommand(
    sessionId: string,
    promptFile: string,
    repositoryPath: string | undefined,
    settings: AgentSessionSettings,
  ): CliAgentCommand;

  /** Reads the output of the tool. An implementation must never throw. */
  protected abstract parseOutput(text: string): CliAgentParse;

  /**
   * docs/specs/agent-session-usage-and-hangs.md. Reads the usage of one invocation from the CLI
   * after its process ended, on every outcome, because a failed or hung session costs money too.
   * A throw is caught and read as a missing record.
   */
  protected abstract readUsage(context: CliUsageContext): Promise<CliUsageReading>;

  /** The settings of a session when no `settingsFor` is given: the constructor options. */
  protected abstract defaultSettings(role: AgentRole): Omit<AgentSessionSettings, "silenceLimitMs">;

  private async settingsOf(input: AgentRunInput): Promise<AgentSessionSettings> {
    if (this.cliOptions.settingsFor !== undefined) return this.cliOptions.settingsFor(input, this.name);
    return { ...this.defaultSettings(input.role), silenceLimitMs: this.silenceLimitMs };
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
    const settings = await this.settingsOf(input);
    const promptFile = await this.writePrompt(input.sandbox, input.ref, input.prompt);
    const command = this.startCommand(promptFile, input.repositoryPath, settings);
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
      settings,
      cancelled: false,
      counted: new Set<string>(),
      cliSessionId: null,
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
      throw new AgentSessionUnavailableError(this.name, session.sessionId);
    }

    const promptFile = await this.writePrompt(previous.sandbox, previous.ref, input.prompt);
    const command = this.resumeCommand(session.sessionId, promptFile, previous.repositoryPath, previous.settings);
    const process = await previous.sandbox.startProcess(previous.ref, {
      file: command.file,
      args: command.args,
      cwd: previous.workingDirectory,
      env: { ...previous.environment, ...command.env },
    });

    const live: LiveSession = {
      ...previous,
      process,
      cancelled: false,
      cliSessionId: session.sessionId === session.processId ? previous.cliSessionId : session.sessionId,
    };
    this.sessions.set(process.id, live);
    const owner = this.runOfProcess(session.processId);
    if (owner === undefined) return await this.awaitProcess(live, input.timeoutMs);
    this.trackProcess(owner, process.id);
    // A resumed session is the live session of its Run, so a stop can find it and cancel it.
    // DI-14.47.
    this.activeByRun.set(owner, process.id);
    try {
      return await this.awaitProcess(live, input.timeoutMs);
    } finally {
      if (this.activeByRun.get(owner) === process.id) this.activeByRun.delete(owner);
    }
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
   * Polls the sandbox process until it exits, its budget ends, it stays silent for the silence
   * limit, or Factoree cancels it.
   *
   * The silence limit exists because an agent can wait for ever on a connection that will never
   * answer. A sandbox that pauses drops every open connection, and a CLI that sets no timeout of
   * its own then sleeps until the Run budget ends, which wastes the whole budget on a session
   * that stopped working minutes after it started. Output is the signal: a working agent writes
   * events continuously. docs/specs/agent-session-usage-and-hangs.md calls such a session hung.
   */
  private async awaitProcess(live: LiveSession, timeoutMs: number): Promise<AgentRunResult> {
    const startedAt = this.clock();
    const deadline = startedAt + timeoutMs;
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
        return await this.buildResult(live, snapshot, startedAt, {
          cancelled: live.cancelled,
          fallbackExitCode: 1,
        });
      }

      // The budget is checked first. A session that is silent when the Run budget ends ran out
      // of time, and SDD section 50 reports that as a timeout, not as a hang. DI-14.47.
      if (this.clock() >= deadline) {
        // On timeout Factoree cancels the active process and preserves the evidence it already
        // produced. See SDD section 50.
        await live.sandbox.cancelProcess(live.ref, live.process);
        const final = await live.sandbox.readProcess(live.ref, live.process);
        return await this.buildResult(live, final, startedAt, {
          cancelled: true,
          completed: false,
          fallbackExitCode: 124,
        });
      }

      if (this.clock() - lastOutputAt >= live.settings.silenceLimitMs) {
        // The session is hung. Factoree ends it here, so the rest of the Run budget stays
        // available to the one retry of docs/specs/agent-session-usage-and-hangs.md. The
        // evidence it already produced is preserved, the same as on a budget timeout.
        await live.sandbox.cancelProcess(live.ref, live.process);
        const final = await live.sandbox.readProcess(live.ref, live.process);
        const result = await this.buildResult(live, final, startedAt, {
          cancelled: true,
          completed: false,
          fallbackExitCode: 124,
          hung: true,
        });
        return {
          ...result,
          summary:
            `The ${this.name} session wrote nothing for ${Math.round(live.settings.silenceLimitMs / 1000)} seconds, so ` +
            `Factoree ended it. ${result.summary}`.trim(),
        };
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
  private async buildResult(
    live: LiveSession,
    snapshot: ProcessSnapshot,
    startedAt: number,
    options: { cancelled: boolean; completed?: boolean; fallbackExitCode: number; hung?: boolean },
  ): Promise<AgentRunResult> {
    const output = `${snapshot.stdout}\n${snapshot.stderr}`;
    const parsed = this.safeParse(output);
    const sessionId = parsed.sessionId ?? live.cliSessionId;
    const exitCode = snapshot.exitCode ?? options.fallbackExitCode;
    const completed = options.completed ?? (exitCode === 0 && !options.cancelled);
    // A Run that did not finish must state why. The agent's own error outranks its last output
    // line, and it outranks a partial answer, because the partial answer hides the fault.
    const summary =
      !completed && parsed.errorMessage !== undefined && parsed.errorMessage.length > 0
        ? parsed.errorMessage
        : parsed.summary;
    const outcome: AgentSessionOutcome = options.hung === true ? "hung" : completed ? "finished" : "failed";
    // The duration ends when the process ends. The usage read below is Factoree's own time.
    const durationMs = this.clock() - startedAt;
    const reading = await this.safeReadUsage({
      sandbox: live.sandbox,
      ref: live.ref,
      directory: live.repositoryPath ?? live.workingDirectory,
      environment: live.environment,
      role: live.role,
      settings: live.settings,
      sessionId,
      output,
      counted: live.counted,
    });
    return {
      session: {
        sessionId: sessionId ?? live.process.id,
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
      durationMs,
      cancelled: options.cancelled,
      outcome,
      silenceLimitMs: live.settings.silenceLimitMs,
      usage: reading.usage,
      model: reading.model,
      effort: live.settings.effort,
      toolInputs: reading.toolInputs ?? [],
    };
  }

  /** Reads the usage and never throws. Cost is a metric, so a fault here must not fail the Run. */
  private async safeReadUsage(context: CliUsageContext): Promise<CliUsageReading> {
    try {
      return await this.readUsage(context);
    } catch {
      return { usage: null, model: null };
    }
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
