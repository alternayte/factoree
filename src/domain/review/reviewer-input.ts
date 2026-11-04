import type { ActionPolicy } from "~/domain/policy/action-policy.js";
import { guardAgainstForbiddenMaterial } from "~/domain/runs/implementer-input.js";
import { REVIEW_REPORT_SCHEMA_TEXT } from "~/domain/review/review-report.js";
import { REVIEWER_PROMPT_VERSION, renderReviewerPrompt } from "~/prompts/reviewer.js";

/**
 * SDD section 40 and SDD section 43. Exactly the fixed review baseline, plus the change under
 * review. No field can carry an Implementer transcript or an Implementer summary, which is the
 * strongest form of the SDD section 40 rule.
 */
export interface BuildReviewerInput {
  goal: string;
  validationContract: string;
  contextContract: string | null;
  constraints: string[];
  sourceDiff: string;
  diffTruncated: boolean;
  changedFiles: string[];
  verificationSummary: string;
  repositoryInstructions: string;
  reportPath: string;
  actionPolicy: ActionPolicy;
  /** Non-production Project test secrets only. See SDD section 30. */
  projectTestSecrets: Record<string, string>;
}

export interface ReviewerInput {
  prompt: string;
  promptVersion: string;
  environment: Record<string, string>;
}

export const buildReviewerInput = (input: BuildReviewerInput): ReviewerInput => {
  guardAgainstForbiddenMaterial(input.projectTestSecrets);

  return {
    prompt: renderReviewerPrompt({
      goal: input.goal,
      validationContract: input.validationContract,
      contextContract: input.contextContract,
      constraints: input.constraints,
      sourceDiff: input.sourceDiff,
      diffTruncated: input.diffTruncated,
      changedFiles: input.changedFiles,
      verificationSummary: input.verificationSummary,
      repositoryInstructions: input.repositoryInstructions,
      reportPath: input.reportPath,
      actionPolicy: input.actionPolicy.describe(),
      reportSchema: REVIEW_REPORT_SCHEMA_TEXT,
    }),
    promptVersion: REVIEWER_PROMPT_VERSION,
    environment: { ...input.projectTestSecrets },
  };
};
