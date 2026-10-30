import type { ActionPolicy } from "~/domain/policy/action-policy.js";
import type { Sandbox, SandboxRef } from "./sandbox.js";
import { RunConfigurationError } from "./run-configuration-error.js";

export type AgentRole = "implementer" | "validator" | "reviewer" | "refiner";

export interface AgentSessionRef {
  /** The runner-scoped session identifier. Factoree uses it to resume and to cancel. */
  sessionId: string;
  /** The sandbox process that carries the session. */
  processId: string;
  runner: string;
}

export interface AgentRunInput {
  runId: string;
  tenantId: string;
  role: AgentRole;
  sandbox: Sandbox;
  ref: SandboxRef;
  /** The absolute path the session works from. It is a scratch directory for some roles. */
  workingDirectory: string;
  /**
   * The absolute path of the primary worktree inside the sandbox.
   *
   * A coding agent reads its own configuration from the repository it works on: the model, the
   * provider timeouts, the instructions. The User Validator and the Reviewer work from a scratch
   * directory beside the checkout, by SDD sections 36 and 40, so without this the session found
   * no configuration and fell back to a default model. A real Run proved the cost: the validator
   * ran a model the Project never chose, wrote nothing, and blocked every assertion.
   */
  repositoryPath?: string;
  /** The complete instruction text. It must never carry a forbidden credential. */
  prompt: string;
  promptVersion: string;
  /** Values placed in the process environment. Project test secrets only. See SDD section 30. */
  environment: Record<string, string>;
  actionPolicy: ActionPolicy;
  timeoutMs: number;
}

export interface AgentResumeInput {
  prompt: string;
  timeoutMs: number;
}

/** What a cancel call actually did. SDD section 50 obligation 1 must not report a silent success. */
export type AgentCancelOutcome = "cancelled" | "no-live-session";

export interface AgentRunResult {
  session: AgentSessionRef;
  /** True only when the runner process exited zero. It is a claim, not evidence. See SDD section P-01. */
  completed: boolean;
  exitCode: number;
  /** The redacted final message. Factoree does not persist full transcripts. See SDD section 61. */
  summary: string;
  durationMs: number;
  /** True when Factoree cancelled the session. */
  cancelled: boolean;
  /**
   * The bounded, redacted log of a session that did not finish, and null for one that did. SDD
   * section 61 forbids a full transcript, and SDD section 39 needs an artifact that outlives the
   * sandbox. A failure that reaches only the sandbox filesystem is lost when the sandbox is
   * destroyed, and an operator then has nothing to read.
   */
  failureLog: string | null;
}

/** SDD section 33 requires that Temporal workflows depend only on this interface. */
export interface AgentRunner {
  readonly name: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
  resume(session: AgentSessionRef, input: AgentResumeInput): Promise<AgentRunResult>;
  cancel(session: AgentSessionRef): Promise<AgentCancelOutcome>;
  /**
   * Disposes every session this runner holds for one Run. A Run has a known end, and the
   * workflow reaches that end, so no timer and no size cap is needed. The member is optional,
   * because a runner that holds no per-Run state has nothing to release.
   */
  releaseRun?(runId: string): void;
}

export class UnknownAgentRunnerError extends Error {
  constructor(name: string, known: string[]) {
    super(`No agent runner is registered under "${name}". Registered runners: ${known.join(", ")}.`);
    this.name = "UnknownAgentRunnerError";
  }
}

/** SDD section 14 requires that runner selection is configuration driven. A call site must not hard code it. */
export class AgentRunnerRegistry {
  private readonly runners = new Map<string, AgentRunner>();

  constructor(runners: AgentRunner[] = []) {
    for (const runner of runners) this.register(runner);
  }

  register(runner: AgentRunner): void {
    if (this.runners.has(runner.name)) {
      throw new Error(`An agent runner named "${runner.name}" is already registered.`);
    }
    this.runners.set(runner.name, runner);
  }

  get(name: string): AgentRunner {
    const runner = this.runners.get(name);
    if (runner === undefined) throw new UnknownAgentRunnerError(name, [...this.runners.keys()]);
    return runner;
  }

  names(): string[] {
    return [...this.runners.keys()].sort();
  }

  /** Every registered runner. The order is the registration order. */
  all(): AgentRunner[] {
    return [...this.runners.values()];
  }
}

/**
 * SDD section 14 requires configuration-driven runner selection. A name that no adapter
 * implements is an operator fault, so it must fail where the operator sees it, at preparation,
 * and not deep inside the Implementer activity. Every unknown name reaches the message, so one
 * repair round fixes the whole file.
 */
export const assertKnownRunners = (
  registry: AgentRunnerRegistry,
  runtime: { implementerRunner: string; validatorRunner: string; reviewerRunner: string },
): void => {
  const known = new Set(registry.names());
  const unknown = [...new Set([runtime.implementerRunner, runtime.validatorRunner, runtime.reviewerRunner])]
    .filter((name) => !known.has(name))
    .sort();
  if (unknown.length === 0) return;
  throw new RunConfigurationError(
    `.factoree/config.yaml names an agent runner Factoree does not implement: ` +
      `${unknown.map((name) => `"${name}"`).join(", ")}. ` +
      `The registered runners are: ${registry.names().join(", ")}.`,
  );
};
