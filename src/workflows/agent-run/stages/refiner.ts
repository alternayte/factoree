import { deprecatePatch } from "@temporalio/workflow";
import type { ProposeRefinementActivityOutput } from "~/activities/refinement.activities.js";
import type { ForYourEyeCriterion } from "~/domain/validation/for-your-eye.js";
import type { DecisionAnswer } from "~/domain/refinement/refiner-proposal.js";
import type { RefinerDecisionLine } from "~/prompts/refiner.js";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import { mergeOrderDecision } from "../../../domain/runs/merge-order.js";
import { activities, buildSessionActivities } from "../activities.js";
import { PATCH } from "../patches.js";
import type { Run } from "../run.js";
import { egressOf, endIfSessionFailed, runSession, setTargetsInput, spriteOf } from "../sessions.js";
import { resolveContextAgain, verifyIdentity, type ContextSource, type ResolvedContext } from "./context.js";
import { targetsInput, type Workspace } from "./preparation.js";
import type { Refined } from "./refinement.js";

export type Proposal = ProposeRefinementActivityOutput;

export interface RefinerOutcome {
  proposal: Proposal;
  /** A refiner that freezes nothing leaves the criteria the Work Item states. */
  contractCriteria: Refined["criteria"];
  forYourEye: ForYourEyeCriterion[];
  context: ResolvedContext;
  /** DI-21.141. The cited provider-to-consumer edges of the set, or null when the refiner cited none. */
  edges: Array<{ provider: string; consumer: string }> | null;
  /** docs/specs/pr-feedback-loop.md, DI-21.215. One answer per human decision the run carries, or empty. */
  decisionAnswers: DecisionAnswer[];
}

/** The text the refiner reads. A PR follow-up run adds its human decisions (DI-21.215). */
export type RefinerSource = ContextSource & { description: string; humanDecisions?: RefinerDecisionLine[] };

/**
 * docs/specs/refiner-agent.md. A fresh refiner reads the work sprite and proposes what done means
 * and how to prove it. The gate decides what freezes, and Factoree takes every other proposal
 * itself (docs/specs/own-proposals-and-parallel-runs.md).
 */
const propose = async (run: Run, source: RefinerSource, context: ResolvedContext, workspace: Workspace): Promise<Proposal> => {
  const { input } = run;
  const work = workspace.work;
  const content = source.workItem.content;
  await run.enter("REFINING");
  let proposal: ProposeRefinementActivityOutput | null = null;
  try {
    proposal = await runSession(run, "refiner", (afterHang, unreachableRetry) =>
      run.agentActivity(() =>
        buildSessionActivities(run.remainingMs()).proposeRefinement({
          runId: run.id,
          tenantId: input.tenantId,
          productId: input.productId,
          // docs/specs/claude-code-runner.md. An old history holds no refiner runner.
          runnerName: work.runtime.refinerRunner ?? work.runtime.validatorRunner,
          ...spriteOf(work),
          ...setTargetsInput(work),
          // docs/specs/change-sets.md, DI-21.139. The refiner may add a target and cite edges.
          primaryRepository: context.primary.slug,
          ...(work.siblings === undefined ? {} : { siblings: work.siblings }),
          ...(workspace.targetsOpen ? { targetsOpen: true } : {}),
          // DI-21.54. The kept human comments are Work Item text too.
          workItemText:
            content?.comments === null || content?.comments === undefined
              ? `${input.workItem.title}\n\n${source.description}`
              : `${input.workItem.title}\n\n${source.description}\n\n${content.comments}`,
          goal: source.refined.goal,
          statedCriteria: source.refined.acceptanceCriteria,
          contextContract: context.document,
          contextFiles: work.contextFiles ?? [],
          imageFiles: work.imageFiles ?? [],
          skills: work.skills,
          previewConfigured: work.preview !== null && work.preview.enabled,
          egress: egressOf(work),
          // GitHub issue 93, DI-21.192. The refiner builds test checks from the proven verify commands.
          ...(work.verifyCommands.length === 0
            ? {}
            : { verifyCommands: work.verifyCommands.map((command) => ({ name: command.name, run: command.run })) }),
          timeoutMs: run.remainingMs(),
          ...(afterHang ? { afterHang: true } : {}),
          ...(unreachableRetry > 0 ? { unreachableRetry } : {}),
          ...(input.product.refinerCriteriaLimit === undefined ? {} : { criteriaLimit: input.product.refinerCriteriaLimit }),
          ...((source.humanDecisions ?? []).length === 0 ? {} : { humanDecisions: source.humanDecisions }),
        }),
      ),
    );
  } catch (error) {
    await run.failFrom(
      error,
      "Factoree could not start the Refiner, because the Run configuration is invalid. Repair `validator_runner` in `.factoree/config.yaml`.",
    );
  }
  if (run.stopped) await run.cancel();
  if (proposal === null) {
    await run.ensureTime();
    return await run.fail("REFINEMENT_UNAVAILABLE", "The Refiner did not finish, so Factoree published nothing.");
  }
  await endIfSessionFailed(run, "refiner", proposal);
  if (proposal.status !== "proposed") {
    // Issue #39, DI-21.66. A proposal over the criteria limit carries a message for the human.
    return await run.fail(
      "REFINEMENT_UNAVAILABLE",
      proposal.message ?? `Factoree could not use the Refiner proposal. ${proposal.reason} Factoree published nothing.`,
    );
  }
  return proposal;
};

/**
 * docs/specs/change-sets.md, DI-21.140. Each target the gate accepted joins the Run at the SHA the
 * refiner read, after the identity check of its base. The edges give the merge order (DI-21.141).
 * Then the context resolves again for the set (DI-21.143), and the work sprite prepares again.
 */
const joinAddedTargets = async (
  run: Run,
  source: ContextSource,
  proposal: Proposal,
  context: ResolvedContext,
  workspace: Workspace,
): Promise<{ context: ResolvedContext; edges: Array<{ provider: string; consumer: string }> | null }> => {
  const { input } = run;
  const bases = workspace.bases;
  deprecatePatch(PATCH.changeSetRefiner);
  let joined = 0;
  for (const added of proposal.addedTargets ?? []) {
    const repository = input.product.repositories.find((candidate) => candidate.fullName.toLowerCase() === added.repository.toLowerCase());
    if (repository === undefined) continue;
    await activities.recordRunTarget({
      tenantId: input.tenantId,
      runId: run.id,
      repositoryId: repository.id,
      selectionReason: `the refiner cited ${added.file} line ${String(added.line)}: ${added.reason}`,
    });
    await verifyIdentity(run, { slug: repository.fullName, sha: added.commitSha, githubInstallationId: repository.githubInstallationId });
    await activities.recordRunTargetFacts({ tenantId: input.tenantId, runId: run.id, repositoryId: repository.id, baseSha: added.commitSha });
    bases.push({ id: repository.id, fullName: repository.fullName, githubInstallationId: repository.githubInstallationId, slug: repository.fullName, sha: added.commitSha });
    await run.takeDecision(added.decision);
    joined += 1;
  }
  let edges: Array<{ provider: string; consumer: string }> | null = null;
  const cited = proposal.edges ?? [];
  if (bases.length > 1 && cited.length > 0) {
    edges = cited.map((edge) => ({ provider: edge.provider, consumer: edge.consumer }));
    const order = await activities.recordRunTargetEdges({ tenantId: input.tenantId, runId: run.id, edges: cited });
    const decision = mergeOrderDecision(order, cited);
    if (decision !== null) await run.takeDecision(decision);
  }
  if (joined === 0) return { context, edges };
  if (run.stopped) await run.cancel();
  deprecatePatch(PATCH.changeSetContext);
  const setContext = await resolveContextAgain(run, source, context, bases);
  if (run.stopped) await run.cancel();
  workspace.prepareInput = {
    ...workspace.prepareInput,
    ...(setContext.deliveryRefs === undefined ? {} : { contextRefs: setContext.deliveryRefs }),
    ...targetsInput(run, bases),
  };
  await run.enter("PREPARING");
  await workspace.prepare(workspace.workInput(false));
  await run.checkpoint();
  return { context: setContext, edges };
};

/**
 * The refiner stage: the proposal, the missing hosts, Factoree's own decisions, the targets the
 * refiner adds, and the context conflicts it cites. docs/specs/context-authority-and-cited-conflicts.md:
 * the context resolves again with the cited conflicts, so a quoted disagreement of one authority
 * class asks a human before anything freezes.
 */
export const runRefiner = async (
  run: Run,
  source: RefinerSource,
  firstContext: ResolvedContext,
  workspace: Workspace,
): Promise<RefinerOutcome> => {
  let context = firstContext;
  const proposal = await propose(run, source, context, workspace);
  // DI-21.48. A host the work needs and the allow list does not hold stops the Run before anything freezes.
  const missingHosts = proposal.missingHosts ?? [];
  if (missingHosts.length > 0) await workspace.failMissingHosts("refiner", missingHosts, context.primary.slug);
  for (const decision of proposal.decisions) await run.takeDecision(decision);
  let edges: RefinerOutcome["edges"] = null;
  if (workspace.targetsOpen) ({ context, edges } = await joinAddedTargets(run, source, proposal, context, workspace));
  const conflictReports = proposal.conflicts ?? [];
  if (conflictReports.length > 0) {
    deprecatePatch(PATCH.citedConflicts);
    context = await resolveContextAgain(run, source, context, workspace.bases, conflictReports);
    if (run.stopped) await run.cancel();
  }
  return {
    proposal,
    contractCriteria: proposal.accepted.length === 0 ? source.refined.criteria : proposal.accepted,
    forYourEye: proposal.forYourEye ?? [],
    context,
    edges,
    decisionAnswers: proposal.decisionAnswers ?? [],
  };
};
