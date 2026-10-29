/**
 * docs/specs/refiner-agent.md. True when a human reply accepts the proposal of a question. This
 * file imports nothing, because the Run workflow bundle reads it.
 */
export const acceptsProposal = (answer: string): boolean =>
  /^\s*(yes|y|ok|accept|accepted|agreed)\b/i.test(answer);
