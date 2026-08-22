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

/** SDD section 29 permits exactly one Project override: staging read. */
export interface ActionPolicyOverrides {
  stagingRead?: boolean;
}

export class ActionDeniedError extends Error {
  constructor(readonly action: AgentAction) {
    super(`The Action Policy denies this action: ${LABELS[action]}.`);
    this.name = "ActionDeniedError";
  }
}

export interface ActionPolicy {
  decide(action: AgentAction): ActionDecision;
  assertAllowed(action: AgentAction): void;
  /** One line per action, for the Implementer prompt. The prompt is not the boundary. */
  describe(): string[];
}

export const buildActionPolicy = (overrides: ActionPolicyOverrides = {}): ActionPolicy => {
  const table: Record<AgentAction, ActionDecision> = {
    ...DEFAULTS,
    stagingRead: overrides.stagingRead === true ? "allow" : "deny",
  };

  return {
    decide: (action) => table[action],
    assertAllowed: (action) => {
      if (table[action] === "deny") throw new ActionDeniedError(action);
    },
    describe: () => AGENT_ACTIONS.map((action) => `${table[action]}: ${LABELS[action]}`),
  };
};
