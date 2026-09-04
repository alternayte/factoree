import type { Logger } from "~/telemetry/logger.js";
import { metrics } from "~/telemetry/metrics.js";
import type {
  RecordedDecision,
  RefinementEngine,
  RefinementProject,
  RefinementQuestion,
} from "~/domain/refinement/refinement-engine.js";
import type { WorkItemSource } from "~/domain/refinement/work-item.js";

export interface RefineActivityInput {
  runId: string;
  tenantId: string;
  productId: string;
  source: WorkItemSource;
  project: RefinementProject;
  decisions: RecordedDecision[];
}

export interface RefineActivityOutput {
  status: "ready" | "needs_input";
  goal: string;
  primaryRepository: string;
  referenceRepositories: string[];
  /** The statements only. The workflow needs them for the context topics. */
  acceptanceCriteria: string[];
  /**
   * The proposed acceptance criteria with their identifiers. SDD section 24 requires each
   * validation assertion to name its source requirement, and the identifier is that name.
   * `acceptanceCriteria` above stays a list of statements, because the context topics need the
   * statements only.
   */
  criteria: Array<{ id: string; statement: string; source: string }>;
  /** Every reference the Work Item declared, as written. */
  workItemReferences: string[];
  risks: string[];
  /** SDD section 7 and section 40. The constraints the Work Item stated. */
  constraints: string[];
  unresolvedQuestions: RefinementQuestion[];
  autonomyLevel: string;
}

export interface RefinementActivityDependencies {
  refinement: RefinementEngine;
  logger: Logger;
}

/**
 * SDD section 63 names this file. SDD section 8 puts Refinement before the readiness gate and
 * before a sandbox exists. The activity therefore holds no sandbox and no agent runner. It is a
 * pure function of its input, so a Temporal retry causes no side effect.
 */
export const createRefinementActivities = (dependencies: RefinementActivityDependencies) => ({
  refine(input: RefineActivityInput): Promise<RefineActivityOutput> {
    const started = Date.now();
    const output = dependencies.refinement.refine({
      source: input.source,
      project: input.project,
      decisions: input.decisions,
    });
    // A Temporal workflow must stay deterministic, so the metric belongs here.
    metrics.refinementDuration.observe(
      { tenant_id: input.tenantId, product_id: input.productId },
      (Date.now() - started) / 1000,
    );
    dependencies.logger.info("run refined", {
      tenant_id: input.tenantId,
      product_id: input.productId,
      run_id: input.runId,
      step: "refine",
      status: output.status,
    });
    return Promise.resolve({
      status: output.status,
      goal: output.goal,
      primaryRepository: output.primaryRepository,
      referenceRepositories: output.referenceRepositories,
      acceptanceCriteria: output.proposedAcceptanceCriteria.map((criterion) => criterion.statement),
      criteria: output.proposedAcceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        statement: criterion.statement,
        source: criterion.source,
      })),
      workItemReferences: output.workItem.references.map((reference) => reference.value),
      risks: output.risks,
      constraints: output.workItem.constraints,
      unresolvedQuestions: output.unresolvedQuestions,
      autonomyLevel: output.autonomyLevel,
    });
  },
});
