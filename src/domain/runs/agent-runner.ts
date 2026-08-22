import type { ActionPolicy } from "~/domain/policy/action-policy.js";
import type { Sandbox, SandboxRef } from "./sandbox.js";

export type AgentRole = "implementer" | "validator" | "reviewer";

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
  /** The absolute path of the primary worktree inside the sandbox. */
  workingDirectory: string;
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
}

/** SDD section 33 requires that Temporal workflows depend only on this interface. */
export interface AgentRunner {
  readonly name: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
  resume(session: AgentSessionRef, input: AgentResumeInput): Promise<AgentRunResult>;
  cancel(session: AgentSessionRef): Promise<void>;
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
}
