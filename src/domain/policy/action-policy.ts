import type { AgentRole } from "~/domain/runs/agent-runner.js";

/** SDD section 29. The complete set of actions the policy governs. */
export const AGENT_ACTIONS = [
  "readPrimaryRepository",
  "writePrimaryWorktree",
  "readReferenceRepository",
  "writeReferenceRepository",
  "runProjectCommands",
  "installApprovedDependencies",
  "arbitraryOutboundNetwork",
  "approvedRegistries",
  "approvedTestServices",
  "stagingRead",
  "stagingWrite",
  "gitRemoteWriteFromAgent",
  "productionAccess",
  "merge",
] as const;

export type AgentAction = (typeof AGENT_ACTIONS)[number];
export type ActionDecision = "allow" | "deny";

const DEFAULTS: Record<AgentAction, ActionDecision> = {
  readPrimaryRepository: "allow",
  writePrimaryWorktree: "allow",
  readReferenceRepository: "allow",
  writeReferenceRepository: "deny",
  runProjectCommands: "allow",
  installApprovedDependencies: "allow",
  arbitraryOutboundNetwork: "deny",
  approvedRegistries: "allow",
  approvedTestServices: "allow",
  stagingRead: "deny",
  stagingWrite: "deny",
  gitRemoteWriteFromAgent: "deny",
  productionAccess: "deny",
  merge: "deny",
};

const LABELS: Record<AgentAction, string> = {
  readPrimaryRepository: "read the primary repository",
  writePrimaryWorktree: "write the primary worktree",
  readReferenceRepository: "read a reference repository",
  writeReferenceRepository: "write a reference repository",
  runProjectCommands: "run project commands",
  installApprovedDependencies: "install approved dependencies",
  arbitraryOutboundNetwork: "reach an arbitrary outbound network address",
  approvedRegistries: "reach an approved registry",
  approvedTestServices: "reach an approved test service",
  stagingRead: "read staging",
  stagingWrite: "write staging",
  gitRemoteWriteFromAgent: "write to a git remote",
  productionAccess: "reach production",
  merge: "merge",
};

/**
 * SDD section 29 permits exactly one Project override: staging read. SDD section 58 adds a
 * second, separate override: the exact MCP tool names a Project allow-lists. An empty list, the
 * default, denies every tool. See controller decision 10.
 */
export interface ActionPolicyOverrides {
  stagingRead?: boolean;
  mcpAllowedTools?: string[];
  /**
   * The session role. This is not a Project override; it is the role of the session, so it does
   * not count against the one Project override SDD section 29 permits. `implementer` writes the
   * primary worktree; no other role does. See controller decision 14.
   */
  role?: AgentRole;
}

/**
 * A sibling action names one repository of the Run's Product, other than the target. The
 * decision depends on the Run's own member list, so it takes that list on every call instead of
 * living in `ActionPolicyOverrides`, which holds only Project-wide and session-wide values.
 */
export type SiblingAction = "clone_sibling" | "write_sibling";

export interface SiblingActionInput {
  action: SiblingAction;
  /** The `owner/repo` full name of the sibling repository. */
  fullName: string;
  /** The full names of every repository the Run's Product owns. */
  members: string[];
}

/** Thrown when a sibling action is denied. See `decideSiblingAction`. */
export class SiblingActionDeniedError extends Error {
  constructor(
    readonly action: SiblingAction,
    readonly fullName: string,
  ) {
    super(`The Action Policy denies the sibling action "${action}" for repository "${fullName}".`);
    this.name = "SiblingActionDeniedError";
  }
}

/**
 * Decides one sibling repository action.
 * The policy allows a clone only for a member repository of the Run's Product.
 * The membership check reads the actual member list, never a name pattern. A
 * write to a sibling is always denied, because a sibling clone exists for read-only context
 * alone.
 */
export const decideSiblingAction = (input: SiblingActionInput): ActionDecision => {
  if (input.action === "write_sibling") return "deny";
  return input.members.includes(input.fullName) ? "allow" : "deny";
};

export class ActionDeniedError extends Error {
  constructor(readonly action: AgentAction) {
    super(`The Action Policy denies this action: ${LABELS[action]}.`);
    this.name = "ActionDeniedError";
  }
}

/** SDD section 58. Thrown by `assertMcpTool` when the Project did not allow-list the tool. */
export class McpToolDeniedError extends Error {
  constructor(readonly toolName: string) {
    super(
      `The Action Policy denies the MCP tool "${toolName}". SDD section 58 requires an explicit ` +
        "allow list, and this Project did not name the tool.",
    );
    this.name = "McpToolDeniedError";
  }
}

export interface ActionPolicy {
  decide(action: AgentAction): ActionDecision;
  assertAllowed(action: AgentAction): void;
  /** One line per action, for the Implementer prompt. The prompt is not the boundary. */
  describe(): string[];
  /**
   * SDD section 58. MCP is an extension mechanism, not an unrestricted trust boundary. Every
   * tool call passes this decision, and an Implementer receives no organization-wide access by
   * default, because the allow list starts empty. A name is matched exactly: a pattern would
   * reintroduce the broad access the specification forbids. See controller decision 10.
   */
  decideMcpTool(name: string): ActionDecision;
  assertMcpTool(name: string): void;
}

export const buildActionPolicy = (overrides: ActionPolicyOverrides = {}): ActionPolicy => {
  const role: AgentRole = overrides.role ?? "implementer";
  const table: Record<AgentAction, ActionDecision> = {
    ...DEFAULTS,
    stagingRead: overrides.stagingRead === true ? "allow" : "deny",
    // SDD section 36. Only the Implementer writes the primary worktree. A validator or a
    // reviewer session must not change a production source file.
    writePrimaryWorktree: role === "implementer" ? "allow" : "deny",
  };
  const mcpAllowedTools = overrides.mcpAllowedTools ?? [];

  const decideMcpTool = (name: string): ActionDecision => (mcpAllowedTools.includes(name) ? "allow" : "deny");

  return {
    decide: (action) => table[action],
    assertAllowed: (action) => {
      if (table[action] === "deny") throw new ActionDeniedError(action);
    },
    describe: () => AGENT_ACTIONS.map((action) => `${table[action]}: ${LABELS[action]}`),
    decideMcpTool,
    assertMcpTool: (name) => {
      if (decideMcpTool(name) === "deny") throw new McpToolDeniedError(name);
    },
  };
};
