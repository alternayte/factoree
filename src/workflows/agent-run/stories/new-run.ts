import { deprecatePatch } from "@temporalio/workflow";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import { deployFailureFindingLines } from "../../../domain/pull-requests/deploys.js";
import { activities } from "../activities.js";
import { notify } from "../failures.js";
import { PATCH } from "../patches.js";
import type { Run, RunEnding } from "../run.js";
import type { AgentRunWorkflowInput } from "../types.js";
import { runChange } from "./change.js";

/** A new run, and a follow-up run, takes a Linear reply: its failure post says how, and offers a draft. */
export const newRunEnding: RunEnding = { failureNote: null, draftOnInternalError: true };

export const NEW_RUN_GREETING = "Factoree accepted the work and started a Run.";

/** Slice 5, DI-21.124. A reply after a failed deploy hands the failure to the first attempt. */
export const deployFailureFindings = (input: AgentRunWorkflowInput): string[] =>
  input.deployFailure === undefined ? [] : deployFailureFindingLines(input.deployFailure);

/**
 * A new run on a Linear issue, or a follow-up run that a reply starts in the agent session of a
 * failed run (docs/specs/run-recovery.md). A follow-up run differs only in its input: the reply
 * and the facts are in the description, its decisions are recorded, and it changes the set of the
 * run it follows. It selects its targets, the refiner may add one, and it opens new pull requests.
 */
export const newRun = async (run: Run): Promise<never> => {
  const { input } = run;
  // docs/specs/egress-honesty-and-issue-status.md, DI-21.49. Started means that Factoree works on
  // the issue. A Linear fault never fails the Run.
  const issueId = input.workItem.issueId;
  if (issueId !== null) {
    deprecatePatch(PATCH.issueStatus);
    run.issueStatusTracked = true;
    await notify(() => activities.startIssueWork({ tenantId: input.tenantId, runId: run.id, issueId }));
  }
  return await runChange(run, {
    description: input.workItem.description,
    primaryRepository: input.product.repositories[0]?.fullName ?? "",
    targets: (linearProject) => ({ kind: "choose", followUpTargets: input.followUpTargets ?? [], linearProject }),
    pinnedBaseOf: null,
    startPoint: (base) => base,
    targetsOpen: true,
    initialFindings: deployFailureFindings(input),
    edges: [],
    pullRequest: null,
  });
};
