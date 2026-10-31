/**
 * docs/specs/own-proposals-and-parallel-runs.md. A determined proposal Factoree took without asking
 * a human. The reason is what lets a reviewer check it, so a decision never exists without one.
 */
export interface FactoreeDecision {
  /** What the decision settled. */
  kind: "target" | "criterion" | "dropped" | "not_built" | "visual_evidence" | "refiner";
  /** The decision as a verb phrase after "Factoree", for example "chose alternayte/c-dash". */
  statement: string;
  /** Why, as a clause after "because". */
  reason: string;
}

/** The sentence a human reads, in Linear and in the proof pack. */
export const describeDecision = (decision: FactoreeDecision): string =>
  `Factoree ${decision.statement.trim().replace(/[.\s]+$/, "")}, because ${decision.reason.trim().replace(/[.\s]+$/, "")}.`;
