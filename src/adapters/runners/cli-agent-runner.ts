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
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import type { AgentSessionOutcome, AgentSessionUsage } from "~/domain/runs/agent-session.js";
import { transcriptTextOf } from "~/domain/retro/transcript.js";
import { PULSE_INTERVAL_MS, type SessionPulseRecorder, type ToolKind } from "~/domain/runs/session-pulse.js";
import {
  PROVIDER_UNREACHABLE_GRACE_MS,
  ProviderOutageWatch,
  isProviderUnreachableText,
} from "./provider-unreachable.js";

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
  /**
   * docs/specs/model-picker.md. The catalog entry an opencode session reads its model from, as
   * JSON, or absent for opencode's own snapshot. The runner writes it into the sandbox.
   */
  modelsFile?: string | null;
  /**
   * GitHub issue 37. The opencode `provider` config of the model, or absent for none. It names
   * environment variables only, never a value.
   */
  providerConfig?: Record<string, unknown> | null;
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
  /**
   * docs/specs/provider-unreachable.md. How long the output may show only provider connectivity
   * errors before the runner ends the session. A test lowers it.
   */
  providerUnreachableGraceMs?: number;
  /**
   * GitHub issue 84. The window between two CPU samples of a silent session. A test lowers it.
   */
  cpuSampleWindowMs?: number;
  /**
   * docs/specs/factory-floor.md. The writer of session pulses. Absent in a test that records none.
   * A failed write never touches the session: a pulse is a picture, not evidence.
   */
  pulses?: SessionPulseRecorder;
  /**
   * docs/specs/retro-agent.md, SDD section 61. Receives the redacted transcript of each ended
   * invocation: the whole process output plus every tool input. The sink keeps it only for a
   * product that keeps transcripts. A failed write never touches the session.
   */
  transcripts?: TranscriptSink;
}

/** docs/specs/retro-agent.md. Where a runner sends the redacted transcript of one invocation. */
export interface TranscriptSink {
  keep(input: { tenantId: string; owner: string; role: AgentRole; invocation: string; text: string }): Promise<void>;
}

/**
 * The default silence limit of an agent session. At `max` effort a model can think for minutes
 * with no output, so the limit is generous. Ten minutes of complete silence means the session
 * stopped working, whatever the process state says.
 */
export const DEFAULT_SILENCE_LIMIT_MS = 10 * 60 * 1_000;

/**
 * GitHub issue 84. A tool call writes nothing until it returns, so a test suite that runs for
 * minutes reads as silence. While a call is open, the session is hung only after this limit. It
 * is the longest shell command a runner allows (`BASH_MAX_TIMEOUT_MS` for claude), plus a margin
 * for the runner to report the timeout.
 */
export const TOOL_CALL_COMMAND_MAX_MS = 30 * 60 * 1_000;
export const OPEN_TOOL_CALL_SILENCE_LIMIT_MS = TOOL_CALL_COMMAND_MAX_MS + 5 * 60 * 1_000;

/**
 * GitHub issue 84. The environment variable that marks every process of one agent invocation, so
 * Factoree can find the processes of a session, its tool calls included, in any runner.
 */
export const AGENT_SESSION_MARKER = "FACTOREE_AGENT_SESSION";

/** GitHub issue 84. The window between two CPU samples of a silent session. */
export const CPU_SAMPLE_WINDOW_MS = 30_000;

/**
 * GitHub issue 84. The CPU time, in clock ticks of 10 ms, that the session processes must use in
 * one sample window to count as working: 0.5 s in 30 s. An idle CLI that waits on a dropped
 * connection uses almost none.
 */
export const CPU_ACTIVE_TICKS = 50;

/**
 * Sums utime and stime of every process whose environment holds the marker. The command name in
 * `stat` can hold spaces, so the fields are read after the last ") ". A process that ends during
 * the read is skipped.
 */
const CPU_SAMPLE_SCRIPT = `marker="$1"; total=0
for dir in /proc/[0-9]*; do
  tr '\\0' '\\n' < "$dir/environ" 2>/dev/null | grep -qx "${AGENT_SESSION_MARKER}=$marker" || continue
  stat=$(cat "$dir/stat" 2>/dev/null) || continue
  set -- \${stat##*) }
  total=$((total + \${12:-0} + \${13:-0}))
done
echo "cpu=$total"`;

/** GitHub issue 84. What the CPU samples of a silent session showed. */
export type SessionProcessActivity = "active" | "idle" | "unreadable";

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
  /** GitHub issue 84. The value of AGENT_SESSION_MARKER in the processes of this invocation. */
  marker: string;
  /** docs/specs/factory-floor.md. The tenant and the run id the pulses of this session name. */
  tenantId: string;
  owner: string;
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
  private readonly providerUnreachableGraceMs: number;
  private readonly clock: () => number;
  private readonly cpuSampleWindowMs: number;
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
    this.providerUnreachableGraceMs = cliOptions.providerUnreachableGraceMs ?? PROVIDER_UNREACHABLE_GRACE_MS;
    this.clock = cliOptions.clock ?? Date.now;
    this.cpuSampleWindowMs = cliOptions.cpuSampleWindowMs ?? CPU_SAMPLE_WINDOW_MS;
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
   * GitHub issue 84. The newest tool call the output started and has not returned, or null. A
   * runner whose output names a tool call only when it returns keeps this default, and its
   * silence limit applies to every call.
   */
  protected openToolCall(stdout: string): { name: string; input: string } | null {
    void stdout;
    return null;
  }

  /**
   * docs/specs/factory-floor.md. The kind of what the session does now, read from its stdout, or
   * null when the runner cannot tell. A runner that keeps this default writes no pulse, and the
   * factory floor shows its session as working.
   */
  protected latestToolKind(stdout: string): ToolKind | null {
    void stdout;
    return null;
  }

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
    const command = await this.withSessionFiles(input.sandbox, input.ref, settings, this.startCommand(promptFile, input.repositoryPath, settings));
    const marker = randomUUID();
    const process = await input.sandbox.startProcess(input.ref, {
      file: command.file,
      args: command.args,
      cwd: input.workingDirectory,
      env: { ...input.environment, ...command.env, [AGENT_SESSION_MARKER]: marker },
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
      marker,
      tenantId: input.tenantId,
      owner: input.runId,
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
    const command = await this.withSessionFiles(
      previous.sandbox,
      previous.ref,
      previous.settings,
      this.resumeCommand(session.sessionId, promptFile, previous.repositoryPath, previous.settings),
    );
    const marker = randomUUID();
    const process = await previous.sandbox.startProcess(previous.ref, {
      file: command.file,
      args: command.args,
      cwd: previous.workingDirectory,
      env: { ...previous.environment, ...command.env, [AGENT_SESSION_MARKER]: marker },
    });

    const live: LiveSession = {
      ...previous,
      marker,
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
  /**
   * Writes the files a command reads besides the prompt, fresh for each command, and adds their
   * paths to its environment. A runner that needs none keeps the command as it is.
   */
  protected withSessionFiles(
    _sandbox: Sandbox,
    _ref: SandboxRef,
    _settings: AgentSessionSettings,
    command: CliAgentCommand,
  ): Promise<CliAgentCommand> {
    return Promise.resolve(command);
  }

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
    // The open tool call of the current output. The output does not change while the session is
    // silent, so one parse serves the whole silence.
    let openCall: { name: string; input: string } | null | undefined;
    // GitHub issue 84. The CPU samples of the current silence. A runner that names no tool call
    // until it returns, such as opencode, still shows a long command through the CPU time of
    // the processes of the session.
    let cpuSample: { ticks: number; at: number } | null = null;
    let cpuState: SessionProcessActivity | "unknown" = "unknown";
    // docs/specs/factory-floor.md. The time of the last pulse. The first poll writes one.
    let lastPulseAt: number | null = null;
    // docs/specs/provider-unreachable.md. One watch per stream, each with its own run of
    // connectivity events and its own deadline. New stdout model activity also clears the stderr
    // watch, because it proves the CLI is working again after a stderr-only error. Any other
    // event in one stream clears only that stream.
    const stdoutWatch = new ProviderOutageWatch(this.providerUnreachableGraceMs);
    const stderrWatch = new ProviderOutageWatch(this.providerUnreachableGraceMs);

    for (;;) {
      const snapshot = await live.sandbox.readProcess(live.ref, live.process);

      const output = `${snapshot.stdout}\n${snapshot.stderr}`;
      if (output !== lastOutput) {
        lastOutput = output;
        lastOutputAt = this.clock();
        openCall = undefined;
        cpuSample = null;
        cpuState = "unknown";
      }
      // The watches read the complete lines each poll added, so a blank line or an unfinished
      // line changes nothing.
      const now = this.clock();
      if (stdoutWatch.feed(snapshot.stdout, now).modelActivity) stderrWatch.clear();
      stderrWatch.feed(snapshot.stderr, now);

      if (snapshot.running && (lastPulseAt === null || now - lastPulseAt >= PULSE_INTERVAL_MS)) {
        lastPulseAt = now;
        this.pulse(live, snapshot.stdout, lastOutputAt, now);
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

      // docs/specs/provider-unreachable.md. The CLI backs off for minutes on a connectivity error
      // and then exits. Factoree ends it early, so the retry has the budget the backoff would burn.
      const deadlines = [stdoutWatch.deadline, stderrWatch.deadline].filter((due): due is number => due !== null);
      if (deadlines.length > 0 && this.clock() >= Math.min(...deadlines)) {
        await live.sandbox.cancelProcess(live.ref, live.process);
        const final = await live.sandbox.readProcess(live.ref, live.process);
        return await this.buildResult(live, final, startedAt, {
          cancelled: true,
          completed: false,
          fallbackExitCode: 1,
          unreachable: true,
        });
      }

      const silentMs = this.clock() - lastOutputAt;
      // GitHub issue 84. A long command is silent, and the session waits on it. Only a call that
      // outlasts the longest command the runner allows makes an open call a hang.
      if (silentMs >= live.settings.silenceLimitMs && openCall === undefined) openCall = this.safeOpenToolCall(snapshot.stdout);
      const open = openCall ?? null;
      if (silentMs >= live.settings.silenceLimitMs && cpuState !== "unreadable" && (cpuSample === null || this.clock() - cpuSample.at >= this.cpuSampleWindowMs)) {
        const ticks = await this.sessionCpuTicks(live);
        if (ticks === null) cpuState = "unreadable";
        else {
          if (cpuSample !== null) cpuState = ticks - cpuSample.ticks >= CPU_ACTIVE_TICKS ? "active" : "idle";
          cpuSample = { ticks, at: this.clock() };
        }
      }
      const working = open !== null || cpuState === "active";
      // The first sample has no window to compare with yet, so the session waits one window.
      const deciding = cpuState === "unknown" && cpuSample !== null;
      const limitMs = working ? Math.max(live.settings.silenceLimitMs, OPEN_TOOL_CALL_SILENCE_LIMIT_MS) : live.settings.silenceLimitMs;
      if (silentMs >= limitMs && !(deciding && !working)) {
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
        const running = open === null ? "" : ` It waited on the ${open.name} call \`${open.input}\`.`;
        const activity: SessionProcessActivity = cpuState === "unknown" ? "unreadable" : cpuState;
        const cpu =
          activity === "idle"
            ? ` Its processes used less than ${String(CPU_ACTIVE_TICKS / 100)} s of CPU time in the last ${String(Math.round(this.cpuSampleWindowMs / 1000))} seconds.`
            : activity === "active"
              ? " Its processes still used CPU time."
              : "";
        return {
          ...result,
          processActivity: activity,
          ...(open === null ? {} : { openToolCall: { ...open, runningMs: silentMs } }),
          summary:
            `The ${this.name} session wrote nothing for ${Math.round(silentMs / 1000)} seconds, so ` +
            `Factoree ended it.${running}${cpu} ${result.summary}`.trim(),
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
    options: { cancelled: boolean; completed?: boolean; fallbackExitCode: number; hung?: boolean; unreachable?: boolean },
  ): Promise<AgentRunResult> {
    // DI-21.17. A shell answers 127 when the command does not exist. The agent never ran, so the
    // caller would only see that it wrote nothing: FAC-74 reported "The refiner wrote no
    // proposal" for `sh: 1: claude: not found`. A missing runner is a configuration fault, and a
    // retry fails the same way.
    if (!options.cancelled && snapshot.exitCode === 127) {
      const said = this.cliOptions.redactor.redact(snapshot.stderr.trim().split("\n").slice(-3).join(" ").slice(-500));
      throw new RunConfigurationError(
        `The ${live.role} session could not start the runner "${this.name}" (exit code 127: ${said}). ` +
          "The sandbox image does not hold it. Name an installed runner under agents in .factoree/config.yaml.",
      );
    }
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
    // docs/specs/provider-unreachable.md. A session that did not finish and whose output names a
    // provider connectivity failure is an infrastructure fault, not an agent fault. A cancel by
    // Factoree is not one, except the fast-fail that cancelled the session for that very reason.
    const unreachable =
      options.hung !== true &&
      !completed &&
      (options.unreachable === true || (!options.cancelled && isProviderUnreachableText(output)));
    const outcome: AgentSessionOutcome =
      options.hung === true ? "hung" : completed ? "finished" : unreachable ? "unreachable" : "failed";
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
    // docs/specs/retro-agent.md. Redacted here, before any byte leaves the worker.
    if (this.cliOptions.transcripts !== undefined) {
      const text = this.cliOptions.redactor.redact(transcriptTextOf(output, reading.toolInputs ?? []));
      await this.cliOptions.transcripts
        .keep({ tenantId: live.tenantId, owner: live.owner, role: live.role, invocation: live.process.id, text })
        .catch(() => undefined);
    }
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
      ...(unreachable ? { failureKind: "PROVIDER_UNREACHABLE" as const } : {}),
      silenceLimitMs: live.settings.silenceLimitMs,
      usage: reading.usage,
      model: reading.model,
      effort: live.settings.effort,
      toolInputs: reading.toolInputs ?? [],
    };
  }

  /**
   * GitHub issue 84. The CPU ticks of every process of the invocation, or null when the sandbox
   * cannot tell. Never a throw: a failed read is no evidence, and the plain silence limit applies.
   */
  private async sessionCpuTicks(live: LiveSession): Promise<number | null> {
    try {
      const result = await live.sandbox.exec(live.ref, { file: "sh", args: ["-c", CPU_SAMPLE_SCRIPT, "sh", live.marker], cwd: "/", timeoutMs: 20_000 });
      const match = /cpu=(\d+)/.exec(result.stdout);
      return result.exitCode === 0 && match !== null ? Number.parseInt(match[1]!, 10) : null;
    } catch {
      return null;
    }
  }

  /**
   * docs/specs/factory-floor.md. Writes one pulse and never waits for it or throws: the write runs
   * beside the poll loop, and a failed write is dropped.
   */
  private pulse(live: LiveSession, stdout: string, lastOutputAt: number, now: number): void {
    const recorder = this.cliOptions.pulses;
    if (recorder === undefined) return;
    let toolKind: ToolKind | null;
    try {
      toolKind = this.latestToolKind(stdout);
    } catch {
      return;
    }
    if (toolKind === null) return;
    void recorder
      .record({ tenantId: live.tenantId, owner: live.owner, role: live.role, toolKind, lastOutputAt: new Date(lastOutputAt), at: new Date(now) })
      .catch(() => undefined);
  }

  /** The open tool call, redacted and bounded, and never a throw. */
  private safeOpenToolCall(stdout: string): { name: string; input: string } | null {
    try {
      const open = this.openToolCall(stdout);
      return open === null ? null : { name: open.name, input: this.cliOptions.redactor.redact(open.input.slice(0, 300)) };
    } catch {
      return null;
    }
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
