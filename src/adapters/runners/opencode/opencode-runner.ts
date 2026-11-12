import type {
  CliAgentCommand,
  CliAgentParse,
  CliAgentRunnerOptions,
  CliUsageContext,
  CliUsageReading,
} from "../cli-agent-runner.js";
import { CliAgentRunner, USAGE_READ_TIMEOUT_MS, type AgentSessionSettings } from "../cli-agent-runner.js";
import { parseOpenCodeOutput } from "./output-parser.js";
import { readOpenCodeExport } from "./export-usage.js";
import type { AgentRole } from "~/domain/runs/agent-runner.js";
import type { Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import { randomUUID } from "node:crypto";

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
const OPENCODE_PERMISSION = { external_directory: "allow" };

/** The inline config of one session. GitHub issue 37: the provider config of the model, when it has one. */
const opencodeConfig = (settings: AgentSessionSettings): string =>
  JSON.stringify({
    permission: OPENCODE_PERMISSION,
    ...(settings.providerConfig === undefined || settings.providerConfig === null ? {} : { provider: settings.providerConfig }),
  });

/** docs/specs/model-picker.md. opencode reads the catalog from the file and fetches none. */
const modelsEnvironment = (path: string): Record<string, string> => ({
  OPENCODE_MODELS_PATH: path,
  OPENCODE_DISABLE_MODELS_FETCH: "1",
});

/**
 * The shell script that starts one non-interactive opencode session. `opencode run` reads the
 * message from standard input when the command line names none, so the prompt never appears in
 * a process listing. See SDD section 30 and DI-11.10.
 */
const START_SCRIPT =
  'cat "$FACTOREE_PROMPT_FILE" | "$FACTOREE_OPENCODE_BIN" run --print-logs --format json "$@"';

/**
 * The usage read. opencode 1.19.5 exits before it flushes a large export into a pipe
 * (anomalyco/opencode#57266), and the sandbox reads stdout through a pipe, so an export over about
 * 128 KB arrived cut off and parsed as nothing. A file receives the whole export, and `cat`
 * flushes it. `$1` is the executable and `$2` the session.
 */
const EXPORT_SCRIPT =
  'f=$(mktemp) || exit 1; "$1" export "$2" > "$f" 2>/dev/null; rc=$?; cat "$f"; rm -f "$f"; exit $rc';

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

/** B-3. The model and its reasoning effort, from the Product, as the same kind of parameters. */
const modelArguments = (settings: AgentSessionSettings): string[] => [
  ...(settings.model === null ? [] : ["--model", settings.model]),
  ...(settings.effort === null ? [] : ["--variant", settings.effort]),
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

  /** A role with no variant of its own takes the default variant. */
  protected defaultSettings(role: AgentRole): Omit<AgentSessionSettings, "silenceLimitMs"> {
    return {
      model: this.options.model ?? null,
      effort: this.options.roleVariants?.[role] ?? this.options.variant ?? null,
      executable: null,
    };
  }

  private executableOf(settings: AgentSessionSettings): string {
    return settings.executable ?? this.executable;
  }

  /**
   * docs/specs/agent-session-usage-and-hangs.md. `opencode export <session>` prints the session
   * with the cost and the tokens of every model call. It runs in the sandbox the session ran in,
   * from the same directory and with the same environment, because opencode keeps a session
   * under the project of that directory.
   */
  protected async readUsage(context: CliUsageContext): Promise<CliUsageReading> {
    const fallbackModel = context.settings.model;
    if (context.sessionId === null) return { usage: null, model: fallbackModel };
    const result = await context.sandbox.exec(context.ref, {
      file: "sh",
      args: ["-c", EXPORT_SCRIPT, "sh", this.executableOf(context.settings), context.sessionId],
      cwd: context.directory,
      env: { ...context.environment, OPENCODE_CONFIG_CONTENT: opencodeConfig(context.settings), OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
      timeoutMs: USAGE_READ_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return { usage: null, model: fallbackModel };
    const reading = readOpenCodeExport(result.stdout, context.counted);
    if (reading === null) return { usage: null, model: fallbackModel };
    for (const id of reading.messageIds) context.counted.add(id);
    return { usage: reading.usage, model: reading.model ?? fallbackModel, toolInputs: reading.toolInputs };
  }

  protected startCommand(
    promptFile: string,
    repositoryPath: string | undefined,
    settings: AgentSessionSettings,
  ): CliAgentCommand {
    return {
      file: "sh",
      // `sh` fills `$0`, so the arguments of the script start after it.
      args: ["-c", START_SCRIPT, "sh", ...modelArguments(settings), ...directoryArguments(repositoryPath)],
      env: {
        FACTOREE_PROMPT_FILE: promptFile,
        FACTOREE_OPENCODE_BIN: this.executableOf(settings),
        OPENCODE_CONFIG_CONTENT: opencodeConfig(settings),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
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
      args: ["-c", RESUME_SCRIPT, "sh", ...modelArguments(settings), ...directoryArguments(repositoryPath)],
      env: {
        FACTOREE_PROMPT_FILE: promptFile,
        FACTOREE_OPENCODE_BIN: this.executableOf(settings),
        FACTOREE_OPENCODE_SESSION: sessionId,
        OPENCODE_CONFIG_CONTENT: opencodeConfig(settings),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      },
    };
  }

  /**
   * docs/specs/model-picker.md. The picker offers models from the catalog Factoree stores, which
   * can be newer than the snapshot inside opencode 1.19.5. The provider entry of the chosen model
   * goes into a fresh file for each command, and opencode reads it instead of fetching models.dev.
   */
  protected override async withSessionFiles(
    sandbox: Sandbox,
    ref: SandboxRef,
    settings: AgentSessionSettings,
    command: CliAgentCommand,
  ): Promise<CliAgentCommand> {
    if (settings.modelsFile === undefined || settings.modelsFile === null) return command;
    const path = `${ref.workspacePath}/.factoree/models/${randomUUID()}.json`;
    await sandbox.writeFile(ref, path, settings.modelsFile);
    return { ...command, env: { ...command.env, ...modelsEnvironment(path) } };
  }

  protected parseOutput(text: string): CliAgentParse {
    return parseOpenCodeOutput(text);
  }
}
