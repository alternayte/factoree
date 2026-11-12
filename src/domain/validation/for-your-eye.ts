import type { EvidenceArtifact } from "~/domain/validation/validation-result.js";

/**
 * docs/specs/by-eye-criteria-and-selector-recheck.md. A criterion a person judges by eye. The gate
 * never freezes it, so it is never an automated pass or fail. Factoree captures one screenshot of
 * its route per attempt, and the Proof Pack shows it under "Needs your eye".
 */
export interface ForYourEyeCriterion {
  /** The gate identifier of the criterion, `AC-R<n>`, as a frozen criterion would carry. */
  id: string;
  statement: string;
  /** The page route, a relative preview path. */
  route: string;
}

/**
 * The capture of one for-your-eye route in one attempt. A failed capture is a line for the human,
 * never a run failure: the screenshot is a help, not evidence.
 */
export type ForYourEyeCapture = ForYourEyeCriterion &
  ({ captured: true; artifact: EvidenceArtifact } | { captured: false; reason: string });

/** The evidence source of the screenshot of one for-your-eye criterion. */
export const forYourEyeSource = (id: string): string => `for-your-eye:${id}:screenshot`;
