import type { CliAgentCommand, CliAgentParse, CliAgentRunnerOptions } from "../cli-agent-runner.js";
import { CliAgentRunner } from "../cli-agent-runner.js";
import { parseClaudeOutput } from "./output-parser.js";

export interface ClaudeCodeRunnerOptions extends CliAgentRunnerOptions {
  /** The executable inside the sandbox. Bootstrap installs it. */
  executable?: string;
}

/**
 * The shell script that starts one non-interactive Claude Code session. The prompt reaches the
 * CLI on standard input, so it never appears on a command line and never reaches a process
 * listing. See SDD section 30 and DI-11.10.
 */
const START_SCRIPT =
  'cat "$FACTOREE_PROMPT_FILE" | "$FACTOREE_CLAUDE_BIN" --print --output-format stream-json --verbose';

/** The same script. It continues the session the environment names. */
const RESUME_SCRIPT =
  'cat "$FACTOREE_PROMPT_FILE" | "$FACTOREE_CLAUDE_BIN" --print --output-format stream-json --verbose ' +
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

  protected startCommand(promptFile: string): CliAgentCommand {
    return {
      file: "sh",
      args: ["-c", START_SCRIPT],
      env: { FACTOREE_PROMPT_FILE: promptFile, FACTOREE_CLAUDE_BIN: this.executable },
    };
  }

  protected resumeCommand(sessionId: string, promptFile: string): CliAgentCommand {
    return {
      file: "sh",
      args: ["-c", RESUME_SCRIPT],
      env: {
        FACTOREE_PROMPT_FILE: promptFile,
        FACTOREE_CLAUDE_BIN: this.executable,
        FACTOREE_CLAUDE_SESSION: sessionId,
      },
    };
  }

  protected parseOutput(text: string): CliAgentParse {
    return parseClaudeOutput(text);
  }
}
