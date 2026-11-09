/**
 * docs/specs/run-failure-detail.md. A failed Run keeps the error text of the step that failed,
 * after the fixed sentence that says what to repair. The failing line sits at the end of an
 * output tail, so a long text keeps its end.
 */
export const FAILURE_CAUSE_MAX_CHARS = 2_000;

/** The failure message of a Run that ends `INTERNAL_ERROR`, before its cause. */
export const INTERNAL_ERROR_SENTENCE = "Factoree stopped the Run because of an internal error.";

/** The sentence, then "Cause: " and the clipped error text. An empty cause adds nothing. */
export const withCauseText = (sentence: string, cause: string): string => {
  const text = cause.trim();
  if (text === "") return sentence;
  const clipped = text.length > FAILURE_CAUSE_MAX_CHARS ? `…${text.slice(-FAILURE_CAUSE_MAX_CHARS)}` : text;
  return `${sentence} Cause: ${clipped}`;
};
