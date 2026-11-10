import type {
  CliAgentCommand,
  CliAgentParse,
  CliAgentRunnerOptions,
  CliUsageContext,
  CliUsageReading,
} from "../cli-agent-runner.js";
import { CliAgentRunner, type AgentSessionSettings } from "../cli-agent-runner.js";
import { parseClaudeOutput } from "./output-parser.js";

export interface ClaudeCodeRunnerOptions extends CliAgentRunnerOptions {
  /** The executable inside the sandbox. Bootstrap installs it. */
  executable?: string;
  /** docs/specs/claude-code-runner.md. An alias or a full `claude-*` id. Absent means the CLI default. */
  model?: string;
  /** One of the Claude Code effort levels. Absent means the model default. */
  effort?: string;
}

/**
 * The shell script that starts one non-interactive Claude Code session. The prompt reaches the
 * CLI on standard input, so it never appears on a command line and never reaches a process
 * listing. See SDD section 30 and DI-11.10.
 *
 * R-3. The repository is untrusted input. `--strict-mcp-config` with no `--mcp-config` starts no
 * MCP server, and `--setting-sources user` skips the project and local settings files of the
 * repository, so a repository cannot add a tool, a hook or a permission to the session.
 *
 * docs/specs/claude-code-runner.md. Print mode denies every tool that needs an approval, so a
 * session could edit nothing. `--dangerously-skip-permissions` lifts the prompt. The sandbox and
 * the Action Policy mechanisms are the boundary of a Run, not the CLI prompt (DI-14.16).
 */
const BASE_FLAGS = "--print --output-format stream-json --verbose --strict-mcp-config --setting-sources user --dangerously-skip-permissions";

/** The model and the directory arguments follow as real positional parameters, as in the opencode runner. */
const START_SCRIPT = `cat "$FACTOREE_PROMPT_FILE" | "$FACTOREE_CLAUDE_BIN" ${BASE_FLAGS} "$@"`;

/** The same script. It continues the session the environment names. */
const RESUME_SCRIPT = `cat "$FACTOREE_PROMPT_FILE" | "$FACTOREE_CLAUDE_BIN" ${BASE_FLAGS} --resume "$FACTOREE_CLAUDE_SESSION" "$@"`;

/**
 * The extra arguments of one session. A validator and a reviewer work from a scratch directory
 * beside the checkout, so `--add-dir` lets the session read and edit the repository too.
 */
const sessionArguments = (settings: AgentSessionSettings, repositoryPath: string | undefined): string[] => [
  ...(settings.model === null ? [] : ["--model", settings.model]),
  ...(repositoryPath === undefined ? [] : ["--add-dir", repositoryPath]),
];

/**
 * The environment of one session. `CLAUDE_CODE_EFFORT_LEVEL` beats every settings file, and only
 * it accepts `max`. A pinned CLI must not update itself, and a session sends no telemetry: the
 * agent phase allows the model host only.
 */
const sessionEnvironment = (settings: AgentSessionSettings): Record<string, string> => ({
  DISABLE_UPDATES: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  ...(settings.effort === null ? {} : { CLAUDE_CODE_EFFORT_LEVEL: settings.effort }),
});

/**
 * SDD section 33 names ClaudeCodeRunner as the second required adapter of the AgentRunner port.
 * It drives the `claude` command line tool inside a sandbox. `CliAgentRunner` holds the poll
 * loop, the budget, the cancel path, and the result build, so this class states only what is
 * specific to Claude Code.
 *
 * docs/specs/claude-code-runner.md. A Product selects it for a role by the name `claude`.
 */
export class ClaudeCodeRunner extends CliAgentRunner {
  readonly name = "claude";
  private readonly executable: string;

  constructor(private readonly options: ClaudeCodeRunnerOptions) {
    super(options);
    this.executable = options.executable ?? "claude";
  }

  protected startCommand(promptFile: string, repositoryPath: string | undefined, settings: AgentSessionSettings): CliAgentCommand {
    return {
      file: "sh",
      // `sh` fills `$0`, so the arguments of the script start after it.
      args: ["-c", START_SCRIPT, "sh", ...sessionArguments(settings, repositoryPath)],
      env: {
        ...sessionEnvironment(settings),
        FACTOREE_PROMPT_FILE: promptFile,
        FACTOREE_CLAUDE_BIN: settings.executable ?? this.executable,
      },
    };
  }

  protected resumeCommand(
    sessionId: string,
    promptFile: string,
    repositoryPath: string | undefined,
    settings: AgentSessionSettings,
  ): CliAgentCommand {
    return {
      file: "sh",
      args: ["-c", RESUME_SCRIPT, "sh", ...sessionArguments(settings, repositoryPath)],
      env: {
        ...sessionEnvironment(settings),
        FACTOREE_PROMPT_FILE: promptFile,
        FACTOREE_CLAUDE_BIN: settings.executable ?? this.executable,
        FACTOREE_CLAUDE_SESSION: sessionId,
      },
    };
  }

  /** Without `settingsFor`, the constructor options. A test uses them. */
  protected defaultSettings(): Omit<AgentSessionSettings, "silenceLimitMs"> {
    return { model: this.options.model ?? null, effort: this.options.effort ?? null, executable: null };
  }

  protected parseOutput(text: string): CliAgentParse {
    return parseClaudeOutput(text);
  }

  /**
   * docs/specs/agent-session-usage-and-hangs.md. Claude Code writes the usage and the cost of one
   * invocation in its result event, so the output already holds them. A resume is a new process
   * with its own result event, so it reports only its own calls.
   */
  protected readUsage(context: CliUsageContext): Promise<CliUsageReading> {
    const parsed = parseClaudeOutput(context.output);
    return Promise.resolve({ usage: parsed.usage, model: parsed.model, toolInputs: parsed.toolInputs });
  }
}
