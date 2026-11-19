import { deprecatePatch, isCancellation } from "@temporalio/workflow";
import type { ReadWorkItemContentActivityOutput } from "~/activities/work-item.activities.js";
import { activities, workItemActivities } from "../activities.js";
import { PATCH } from "../patches.js";
import type { Run } from "../run.js";

/** The question the "ignore the images" reply answers. Its ref is `linear:decision:work-item-images`. */
const IGNORE_IMAGES_DECISION = {
  questionId: "work-item-images",
  question:
    "The issue holds images, and a role model of this product cannot read an image. Must the run check that every agent can see the images?",
} as const;

export interface WorkItemFacts {
  labels: string[];
  /** SDD section 28. A label read that failed caps the Run at L2. */
  labelsUnreadable: boolean;
  /** docs/specs/own-proposals-and-parallel-runs.md. The Linear project can choose the target. */
  linearProject: string | null;
  /** docs/specs/work-item-images-and-links.md. The comments, the images and the links, or null. */
  content: ReadWorkItemContentActivityOutput | null;
}

/**
 * SDD section 28 and docs/specs/work-item-images-and-links.md. Reads the labels, the project, the
 * comments, the images and the links of the issue once at the start. A Linear fault never fails the
 * Run: the risk cap fails closed to L2, and the Run uses the description only.
 */
export const readWorkItem = async (run: Run, description: string): Promise<WorkItemFacts> => {
  const { input } = run;
  const facts: WorkItemFacts = { labels: input.workItem.labels, labelsUnreadable: false, linearProject: null, content: null };
  const issueId = input.workItem.issueId;
  if (issueId !== null) {
    try {
      const read = await activities.fetchWorkItemFacts({ sessionId: input.agentSessionId, issueId });
      facts.labels = read.labels;
      facts.linearProject = read.project;
    } catch (error) {
      if (isCancellation(error)) throw error;
      // The cap of SDD section 28 is a security control, so a degraded cap must be visible.
      facts.labelsUnreadable = true;
      await run.progress("Factoree could not read the labels of this Work Item, so it runs this Run at L2 at most and opens a draft pull request.");
    }
  }
  // A reply "ignore the images" freezes as a decision.
  if (input.ignoreImages === true) {
    run.decisions.push({ ...IGNORE_IMAGES_DECISION, answer: "Ignore the images. A human chose to run without the image check." });
  }
  if (issueId === null) return facts;
  deprecatePatch(PATCH.workItemContent);
  try {
    facts.content = await workItemActivities.readWorkItemContent({
      tenantId: input.tenantId,
      productId: input.productId,
      runId: run.id,
      issueId,
      description,
      delegatedAt: input.delegatedAt ?? null,
      repositories: input.product.repositories.map((repository) => ({
        fullName: repository.fullName,
        githubInstallationId: repository.githubInstallationId,
      })),
    });
  } catch (error) {
    if (isCancellation(error)) throw error;
    // DI-21.45. The human must see what the Run lost.
    await run.progress("Factoree could not read the comments, the images and the links of this issue, so this Run uses the description only.");
  }
  // Before preparation: a role model that cannot read an image ends the Run, unless the human
  // replied "ignore the images".
  if (facts.content !== null && facts.content.visionFailure !== null && input.ignoreImages !== true) {
    await run.fail("CONFIGURATION_INVALID", facts.content.visionFailure);
  }
  return facts;
};
