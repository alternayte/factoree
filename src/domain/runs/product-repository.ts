/**
 * One member repository of a Product, as the domain and the workflow need to see it.
 *
 * F8. This type lived on the workflow module, so `src/domain/runs/sibling-clone.ts` imported
 * from `~/workflows/agent-run.workflow.js` and the domain depended on the workflow layer. It
 * lives here instead, and the workflow imports it, so dependency direction runs domain-first.
 */
export interface AgentRunProductRepositoryInput {
  id: string;
  fullName: string;
  defaultBranch: string;
  /**
   * Specification section 10. `selectTarget` reads this value to apply the sole-member rule to
   * the present repositories only. Null while discovery still sees the configuration file.
   */
  absentSince: string | null;
  /** The installation that granted access to this repository. A clone or a push mints its token against it. */
  githubInstallationId: string;
  /** docs/specs/own-proposals-and-parallel-runs.md. The Linear projects the repository declares. */
  linearProjects: string[];
}
