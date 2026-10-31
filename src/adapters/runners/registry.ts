import { OpenCodeRunner, type OpenCodeRunnerOptions } from "~/adapters/runners/opencode/opencode-runner.js";
import { ClaudeCodeRunner } from "~/adapters/runners/claude-code/claude-code-runner.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import type { Redactor } from "~/telemetry/redaction.js";

/** The opencode settings of one install. */
export type OpenCodeSettings = Pick<OpenCodeRunnerOptions, "model" | "variant" | "roleVariants" | "executable">;

/**
 * SDD section 33 names two required adapters. A stock `.factoree/config.yaml` selects `opencode`
 * for the Implementer and `claude` for the User Validator and the Reviewer, so both must be
 * registered before a stock repository can run.
 *
 * SDD section 14 keeps runner selection configuration driven. This factory only registers the
 * two adapters. It never chooses one.
 */
export const buildAgentRunnerRegistry = (
  redactor: Redactor,
  // docs/specs/kiln-sandbox-provider.md. `executable` is the root-owned CLI of the sandbox image.
  opencode: OpenCodeSettings = {},
): AgentRunnerRegistry =>
  new AgentRunnerRegistry([new OpenCodeRunner({ redactor, ...opencode }), new ClaudeCodeRunner({ redactor })]);
