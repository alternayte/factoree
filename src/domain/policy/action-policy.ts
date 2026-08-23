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
}

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
  const table: Record<AgentAction, ActionDecision> = {
    ...DEFAULTS,
    stagingRead: overrides.stagingRead === true ? "allow" : "deny",
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
