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
}

/**
 * The shell script that starts one non-interactive Claude Code session. The prompt reaches the
 * CLI on standard input, so it never appears on a command line and never reaches a process
 * listing. See SDD section 30 and DI-11.10.
 *
 * R-3. The repository is untrusted input. `--strict-mcp-config` with no `--mcp-config` starts no
 * MCP server, and `--setting-sources user` skips the project and local settings files of the
 * repository, so a repository cannot add a tool, a hook or a permission to the session.
 */
const ISOLATION_FLAGS = "--strict-mcp-config --setting-sources user";

const START_SCRIPT =
  `cat "$FACTOREE_PROMPT_FILE" | "$FACTOREE_CLAUDE_BIN" --print --output-format stream-json --verbose ${ISOLATION_FLAGS}`;

/** The same script. It continues the session the environment names. */
const RESUME_SCRIPT =
  `cat "$FACTOREE_PROMPT_FILE" | "$FACTOREE_CLAUDE_BIN" --print --output-format stream-json --verbose ${ISOLATION_FLAGS} ` +
  '--resume "$FACTOREE_CLAUDE_SESSION"';

/**
 * SDD section 33 names ClaudeCodeRunner as the second required adapter of the AgentRunner port.
 * It drives the `claude` command line tool inside a sandbox. `CliAgentRunner` holds the poll
 * loop, the budget, the cancel path, and the result build, so this class states only what is
 * specific to Claude Code.
 *
 * The name is `claude`, because SDD section 15 sets that name as the stock validator and
 * reviewer of `.factoree/config.yaml`.
 */
export class ClaudeCodeRunner extends CliAgentRunner {
  readonly name = "claude";
  private readonly executable: string;

  constructor(options: ClaudeCodeRunnerOptions) {
    super(options);
    this.executable = options.executable ?? "claude";
  }

  protected startCommand(promptFile: string, _repositoryPath: string | undefined, settings: AgentSessionSettings): CliAgentCommand {
    return {
      file: "sh",
      args: ["-c", START_SCRIPT],
      env: { FACTOREE_PROMPT_FILE: promptFile, FACTOREE_CLAUDE_BIN: settings.executable ?? this.executable },
    };
  }

  protected resumeCommand(
    sessionId: string,
    promptFile: string,
    _repositoryPath: string | undefined,
    settings: AgentSessionSettings,
  ): CliAgentCommand {
    return {
      file: "sh",
      args: ["-c", RESUME_SCRIPT],
      env: {
        FACTOREE_PROMPT_FILE: promptFile,
        FACTOREE_CLAUDE_BIN: settings.executable ?? this.executable,
        FACTOREE_CLAUDE_SESSION: sessionId,
      },
    };
  }

  /**
   * Factoree passes no model and no effort flag to Claude Code, so every role runs at the CLI
   * default. The Product model and effort settings name opencode models.
   */
  protected defaultSettings(): Omit<AgentSessionSettings, "silenceLimitMs"> {
    return { model: null, effort: null, executable: null };
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
