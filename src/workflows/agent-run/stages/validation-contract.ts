import type { Activities } from "~/activities/index.js";
import { validationActivities } from "../activities.js";
import type { Run } from "../run.js";
import type { Refined } from "./refinement.js";

export type ValidationContract = Awaited<ReturnType<Activities["buildValidationContract"]>>;

/**
 * docs/specs/refiner-agent.md and SDD section 24. The Validation Contract freezes after the refiner
 * and before the Implementer. With no observable success assertion, a human states one (SDD
 * section 9 item 5). The question rounds and the budget bound the loop.
 */
export const freezeValidationContract = async (run: Run, refined: Refined, criteria: Refined["criteria"]): Promise<ValidationContract> => {
  const { input } = run;
  const humanAssertions: string[] = [];
  let validation: ValidationContract;
  for (;;) {
    await run.ensureTime();
    await run.enter("BUILDING_VALIDATION_CONTRACT");
    validation = await validationActivities.buildValidationContract({
      runId: run.id,
      tenantId: input.tenantId,
      productId: input.productId,
      workItem: input.workItem.issueId ?? run.id,
      goal: refined.goal,
      acceptanceCriteria: criteria,
      humanAssertions,
    });
    if (validation.status === "ready") {
      // A `ready` result with a null hash is no confirmed frozen contract.
      if (validation.sha256 === null) {
        return await run.fail("VALIDATION_UNRESOLVED", "Factoree could not confirm the Validation Contract froze, so it published nothing.");
      }
      run.control.validationContractVersion = validation.sha256;
      break;
    }
    await run.progress(validation.summary);
    const question = validation.question;
    if (question === null) {
      return await run.fail("VALIDATION_UNRESOLVED", "Factoree could not define success for this Work Item, and it published nothing.");
    }
    const answer = await run.ask(
      { id: question.id, question: question.question },
      {
        reason: "VALIDATION_UNRESOLVED",
        message:
          "Factoree could not start, because this Work Item states no observable success " +
          "assertion. Factoree must not invent product behavior, so it published nothing.",
      },
    );
    if (answer.trim() !== "") humanAssertions.push(answer);
  }
  await run.progress(validation.summary);
  // An assertion that no automated check can answer ends an L3 Run anyway, so stop before any agent time.
  if (validation.manualAssertionIds.length > 0) {
    return await run.fail(
      "VALIDATION_MANUAL_REQUIRED",
      "Factoree cannot check these assertions automatically: " +
        `${validation.manualAssertionIds.join(", ")}. Rewrite each one as an observable result ` +
        "(a command, an HTTP response, or a page state) and delegate again. Factoree started no " +
        "implementation and published nothing.",
    );
  }
  await run.checkpoint();
  return validation;
};
