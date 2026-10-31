import type { CliAgentCommand, CliAgentParse, CliAgentRunnerOptions } from "../cli-agent-runner.js";
import { CliAgentRunner } from "../cli-agent-runner.js";
import { parseOpenCodeOutput } from "./output-parser.js";
import type { AgentRole } from "~/domain/runs/agent-runner.js";

/**
 * The inline configuration of every opencode session Factoree starts.
 *
 * `opencode` confines a tool to its working directory, and it rejects a read outside it. The
 * User Validator and the Reviewer work from a scratch directory beside the checkout, by SDD
 * sections 36 and 40, so every read of the repository was rejected and the User Validator wrote
 * no Validation Plan at all. A real Run proved it: two provable assertions, both `BLOCKED`.
 *
 * The boundary of a Run is the sandbox and the Action Policy, not the working directory of a
 * command, so the session may read across the workspace. `OPENCODE_CONFIG_CONTENT` carries this
 * inline. R-3: `OPENCODE_DISABLE_PROJECT_CONFIG` makes opencode skip the `opencode.json` of the
 * repository, so a repository cannot add an MCP server, a plugin or a permission. The repository
 * therefore cannot choose the model either. The worker chooses it instead (B-3).
 */
const OPENCODE_CONFIG = JSON.stringify({ permission: { external_directory: "allow" } });

/**
 * The shell script that starts one non-interactive opencode session. `opencode run` reads the
 * message from standard input when the command line names none, so the prompt never appears in
 * a process listing. See SDD section 30 and DI-11.10.
 */
const START_SCRIPT =
  'cat "$FACTOREE_PROMPT_FILE" | "$FACTOREE_OPENCODE_BIN" run --print-logs --format json "$@"';

/** The same script. It continues the session the environment names. */
const RESUME_SCRIPT =
  'cat "$FACTOREE_PROMPT_FILE" | "$FACTOREE_OPENCODE_BIN" run --print-logs --format json ' +
  '--session "$FACTOREE_OPENCODE_SESSION" "$@"';

/**
 * The extra arguments of one session, as real positional parameters of the script.
 *
 * They are parameters, not text inside the script and not a value inside an environment
 * variable. A shell removes no quote from the result of an expansion, so a quoted path in a
 * variable reaches the command with its quotes attached, and `opencode` then fails with
 * `Failed to change directory`. A parameter carries a path with a space or a quote unharmed.
 */
const directoryArguments = (repositoryPath: string | undefined): string[] =>
  repositoryPath === undefined ? [] : ["--dir", repositoryPath];

/** B-3. The model and its reasoning effort, from the worker, as the same kind of parameters. */
const modelArguments = (model: string | undefined, variant: string | undefined): string[] => [
  ...(model === undefined ? [] : ["--model", model]),
  ...(variant === undefined ? [] : ["--variant", variant]),
];

export interface OpenCodeRunnerOptions extends CliAgentRunnerOptions {
  /** The executable inside the sandbox. Bootstrap installs it. */
  executable?: string;
  /** B-3. `provider/model`, for example `deepseek/deepseek-flash`. Absent means opencode's default. */
  model?: string;
  /** B-3. The reasoning effort of the model, for example `max`. opencode ignores an unknown one. */
  variant?: string;
  /**
   * DI-14.40. The reasoning effort of one role, over `variant`. A validator writes a plan and a
   * reviewer a verdict that Factoree checks itself, so they can run at a lower effort than the
   * implementer.
   */
  roleVariants?: Partial<Record<AgentRole, string>>;
}

/**
 * SDD section 33 names OpenCodeRunner as a required adapter of the AgentRunner port. It drives
 * the opencode command line tool inside a sandbox. The prompt reaches the tool from a file,
 * because Linux carries at most 131072 bytes in one environment value. `CliAgentRunner` holds every behaviour the
 * two required runners share.
 */
export class OpenCodeRunner extends CliAgentRunner {
  readonly name = "opencode";
  private readonly executable: string;

  constructor(private readonly options: OpenCodeRunnerOptions) {
    super(options);
    this.executable = options.executable ?? "opencode";
  }

  /** The model arguments of one role. A role with no variant of its own takes the default. */
  private modelFor(role: AgentRole): string[] {
    return modelArguments(this.options.model, this.options.roleVariants?.[role] ?? this.options.variant);
  }

  protected startCommand(promptFile: string, repositoryPath: string | undefined, role: AgentRole): CliAgentCommand {
    return {
      file: "sh",
      // `sh` fills `$0`, so the arguments of the script start after it.
      args: ["-c", START_SCRIPT, "sh", ...this.modelFor(role), ...directoryArguments(repositoryPath)],
      env: {
        FACTOREE_PROMPT_FILE: promptFile,
        FACTOREE_OPENCODE_BIN: this.executable,
        OPENCODE_CONFIG_CONTENT: OPENCODE_CONFIG,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      },
    };
  }

  protected resumeCommand(
    sessionId: string,
    promptFile: string,
    repositoryPath: string | undefined,
    role: AgentRole,
  ): CliAgentCommand {
    return {
      file: "sh",
      args: ["-c", RESUME_SCRIPT, "sh", ...this.modelFor(role), ...directoryArguments(repositoryPath)],
      env: {
        FACTOREE_PROMPT_FILE: promptFile,
        FACTOREE_OPENCODE_BIN: this.executable,
        FACTOREE_OPENCODE_SESSION: sessionId,
        OPENCODE_CONFIG_CONTENT: OPENCODE_CONFIG,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      },
    };
  }

  protected parseOutput(text: string): CliAgentParse {
    return parseOpenCodeOutput(text);
  }
}
