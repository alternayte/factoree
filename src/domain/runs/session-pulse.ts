import type { AgentSessionRole } from "./agent-session.js";

/**
 * docs/specs/factory-floor.md. What a running agent session does now, as the factory floor draws
 * it. `think` is a session whose newest event is model text or reasoning, or a tool that is none
 * of the other kinds.
 */
export const TOOL_KINDS = ["read", "edit", "shell", "browser", "think"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/** The most often a running session writes a pulse. */
export const PULSE_INTERVAL_MS = 5_000;

/**
 * One pulse. It holds no tool input and no text, so it carries no secret and no code. `owner` is
 * the run id the runner received: a run id, or `setup:<setupId>` for a setup session.
 */
export interface SessionPulse {
  tenantId: string;
  owner: string;
  role: AgentSessionRole;
  toolKind: ToolKind;
  lastOutputAt: Date;
  at: Date;
}

export interface SessionPulseRecorder {
  record(pulse: SessionPulse): Promise<void>;
}

const READ_TOOLS = new Set(["read", "grep", "glob", "ls", "list", "webfetch", "websearch", "notebookread", "codesearch"]);
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "patch", "apply_patch"]);
const SHELL_TOOLS = new Set(["bash", "shell", "exec", "command"]);
/** A shell command that drives a browser. The validator and the self-check use agent-browser. */
const BROWSER_COMMAND = /(^|[\s;&|(])(agent-browser|playwright|chromium|npx\s+playwright)\b/;

/**
 * The kind of one tool call from its name and, for a shell call, its command. The name is
 * compared without case, and an MCP tool name `mcp__<server>__<tool>` counts by its last part.
 */
export const toolKindOf = (name: string, command: string | null): ToolKind => {
  const lower = name.toLowerCase();
  const tool = lower.includes("__") ? (lower.split("__").at(-1) ?? lower) : lower;
  if (tool.includes("browser") || tool.includes("playwright")) return "browser";
  if (SHELL_TOOLS.has(tool)) return command !== null && BROWSER_COMMAND.test(command) ? "browser" : "shell";
  if (READ_TOOLS.has(tool)) return "read";
  if (EDIT_TOOLS.has(tool)) return "edit";
  return "think";
};
