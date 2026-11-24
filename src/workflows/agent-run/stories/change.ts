import type { Run } from "../run.js";
import { runAttempts } from "../stages/attempts.js";
import { pinTargetBases, resolveFirstContext } from "../stages/context.js";
import { prepareWorkspace, type StartPoint } from "../stages/preparation.js";
import { publish, type ExistingPullRequest } from "../stages/publication.js";
import { runRefiner } from "../stages/refiner.js";
import type { DecisionAnswer } from "~/domain/refinement/refiner-proposal.js";
import type { RefinerDecisionLine } from "~/prompts/refiner.js";
import { refine } from "../stages/refinement.js";
import { reportL0 } from "../stages/reports.js";
import { selectRunTargets, type TargetRule } from "../stages/targets.js";
import { freezeValidationContract } from "../stages/validation-contract.js";
import { readWorkItem } from "../stages/work-item.js";

/** What one kind of run that changes code chooses. Each stage takes these values, never the kind. */
export interface ChangePlan {
  /** The work item text the run refines. A run on a pull request adds the review to it. */
  description: string;
  /** The repository refinement reads as primary before target selection. */
  primaryRepository: string;
  targets: (linearProject: string | null) => TargetRule;
  /** The base each target reads its context at, or null for the default branch. */
  pinnedBaseOf: ((slug: string, primary: boolean) => string | null) | null;
  startPoint: StartPoint;
  /** DI-21.138. The refiner may add a target. */
  targetsOpen: boolean;
  /** The findings the first implementer attempt repairs. */
  initialFindings: string[];
  /** DI-21.159. The edges of the change set a run on a pull request holds. */
  edges: Array<{ provider: string; consumer: string }>;
  /** Null publishes new pull requests. */
  pullRequest: ExistingPullRequest | null;
  /**
   * docs/specs/pr-feedback-loop.md, DI-21.215. The human decisions of a PR follow-up run that the
   * refiner reads, and what the run does with the refiner's answers before the contract freezes. It
   * may end the run ANSWERED. Absent for every other run.
   */
  decisions?: {
    lines: RefinerDecisionLine[];
    afterRefiner: (answers: DecisionAnswer[]) => Promise<void>;
  };
}

/**
 * The stages of a run that changes code, in order: read the issue, refine, select the targets,
 * resolve and pin the context, prepare the work sprite, refine with an agent, freeze the Validation
 * Contract, implement and check until one attempt passes, publish.
 */
export const runChange = async (run: Run, plan: ChangePlan): Promise<never> => {
  const { input } = run;
  await run.ensureTime();
  const workItem = await readWorkItem(run, plan.description);
  const refined = await refine(run, { description: plan.description, facts: workItem, primaryRepository: plan.primaryRepository });
  const targets = await selectRunTargets(run, plan.targets(workItem.linearProject));
  const primary = targets[0];
  const source = { refined, workItem, installationId: primary?.githubInstallationId ?? "" };
  const firstContext = await resolveFirstContext(run, source, targets, plan.pinnedBaseOf);
  await run.checkpoint();
  const bases = await pinTargetBases(run, firstContext, targets);
  if (refined.autonomyLevel === "L0") await reportL0(run, refined, firstContext);

  const workspace = await prepareWorkspace(run, {
    context: firstContext,
    bases,
    workItem,
    goal: refined.goal,
    startPoint: plan.startPoint,
    targetsOpen: plan.targetsOpen,
  });
  const refiner = await runRefiner(
    run,
    { ...source, description: plan.description, ...(plan.decisions === undefined ? {} : { humanDecisions: plan.decisions.lines }) },
    firstContext,
    workspace,
  );
  if (plan.decisions !== undefined) await plan.decisions.afterRefiner(refiner.decisionAnswers);
  const validation = await freezeValidationContract(run, refined, refiner.contractCriteria);
  const edges = refiner.edges ?? plan.edges;
  const verified = await runAttempts(run, {
    workspace,
    context: refiner.context,
    validation,
    brief: { goal: refined.goal, contextContract: refiner.context.document, constraints: refined.constraints, forYourEye: refiner.forYourEye, edges },
    initialFindings: plan.initialFindings,
  });

  // docs/specs/proof-pack-and-visual-evidence.md and run-recovery.md. The gap the human accepted at
  // refinement, or a follow-up whose reply replaced the browser checks of the failed run.
  const dropped = input.followUpBrowserAssertions ?? [];
  const visualEvidenceGap =
    refiner.proposal.visualEvidenceGap ??
    (dropped.length > 0 && (validation.browserAssertionIds ?? ["unknown"]).length === 0
      ? `No visual evidence: the follow-up guidance replaced the browser ${dropped.length === 1 ? "check" : "checks"} ` +
        `${dropped.join(", ")} of the failed run, and this run froze no browser check. Look at the visible change yourself.`
      : null);
  return await publish(run, {
    refined,
    context: refiner.context,
    validation,
    workspace,
    verified,
    edges,
    forYourEye: refiner.forYourEye,
    visualEvidenceGap,
    pullRequest: plan.pullRequest,
  });
};
