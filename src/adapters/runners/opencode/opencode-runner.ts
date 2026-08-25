import type { CliAgentCommand, CliAgentParse, CliAgentRunnerOptions } from "../cli-agent-runner.js";
import { CliAgentRunner } from "../cli-agent-runner.js";
import { parseOpenCodeOutput } from "./output-parser.js";

export interface OpenCodeRunnerOptions extends CliAgentRunnerOptions {
  /** The executable inside the sandbox. Bootstrap installs it. */
  executable?: string;
}

/**
 * SDD section 33 names OpenCodeRunner as a required adapter of the AgentRunner port. It drives
 * the opencode command line tool inside a sandbox. `CliAgentRunner` holds every behaviour the
 * two required runners share.
 */
export class OpenCodeRunner extends CliAgentRunner {
  readonly name = "opencode";
  private readonly executable: string;

  constructor(options: OpenCodeRunnerOptions) {
    super(options);
    this.executable = options.executable ?? "opencode";
  }

  protected startCommand(prompt: string): CliAgentCommand {
    return {
      file: this.executable,
      args: ["run", "--print-logs", "--format", "json"],
      env: { FACTOREE_PROMPT: prompt },
    };
  }

  protected resumeCommand(sessionId: string, prompt: string): CliAgentCommand {
    return {
      file: this.executable,
      args: ["run", "--print-logs", "--format", "json", "--session", sessionId],
      env: { FACTOREE_PROMPT: prompt },
    };
  }

  protected parseOutput(text: string): CliAgentParse {
    return parseOpenCodeOutput(text);
  }
}
