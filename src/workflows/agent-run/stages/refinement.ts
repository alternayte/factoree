import type { Activities } from "~/activities/index.js";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import { renderRisks } from "../../../domain/refinement/risk.js";
import { activities, refineActivities } from "../activities.js";
import type { Run } from "../run.js";
import type { WorkItemFacts } from "./work-item.js";

export type Refined = Awaited<ReturnType<Activities["refine"]>>;

/**
 * SDD section 8. Refinement reads the Work Item and the Project record only, so it runs before
 * preparation. A material product question blocks the Run, and the bounded rounds end the loop.
 * SDD section 28: the capped level governs the Run, so it reaches the row. A risk is reported,
 * never blocking.
 */
export const refine = async (run: Run, workItem: { description: string; facts: WorkItemFacts; primaryRepository: string }): Promise<Refined> => {
  const { input } = run;
  const refinementInput = () => ({
    runId: run.id,
    tenantId: input.tenantId,
    productId: input.productId,
    source: { ...input.workItem, description: workItem.description, labels: workItem.facts.labels },
    project: {
      // A placeholder for refinement only. Target selection sets the primary repository.
      primaryRepository: workItem.primaryRepository,
      // Specification section 12. A repository that is not a target reaches an agent only through
      // clone_sibling, so this list never takes a value from Product membership.
      referenceRepositories: [],
      defaultAutonomy: input.product.defaultAutonomy,
      riskCaps: input.product.riskCaps,
    },
    labelsUnreadable: workItem.facts.labelsUnreadable,
    decisions: run.decisions,
  });

  await run.enter("REFINING");
  let refined = await refineActivities.refine(refinementInput());
  while (refined.status === "needs_input") {
    const question = refined.unresolvedQuestions[0];
    if (question === undefined) {
      return await run.fail("REFINEMENT_UNRESOLVED", "Refinement needs input but named no question, so Factoree cannot continue.");
    }
    await run.ask({ id: question.id, question: question.question }, {
      reason: "REFINEMENT_UNRESOLVED",
      message:
        "Factoree could not start, because a material product decision is still open: " +
        `${question.question} Factoree must not invent product behavior, so it published nothing.`,
    });
    await run.enter("REFINING");
    refined = await refineActivities.refine(refinementInput());
  }

  await activities.setRunAutonomyLevel({ tenantId: input.tenantId, runId: run.id, autonomyLevel: refined.autonomyLevel });
  const riskMessage = renderRisks(refined.risks);
  if (riskMessage !== null) await run.progress(riskMessage);
  return refined;
};
