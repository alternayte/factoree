/**
 * A fault in the configuration of the Run, not in the infrastructure that carries it.
 *
 * A bad repository reference, a reference name collision, an unusable repository URL, and a
 * bootstrap command that fails are all faults an operator must repair. A retry repeats the same
 * fault and wastes the Run budget. SDD section 49 states that a semantic failure must not consume
 * the infrastructure retry policy, so the workflow marks this type non-retryable and maps it to
 * `FAILED_CONFIGURATION` with `CONFIGURATION_INVALID`.
 *
 * The Temporal failure converter reads the constructor name of the error and puts it in the
 * `type` field of the application failure. `RUN_CONFIGURATION_ERROR_TYPE` holds that name, so the
 * workflow and the retry policy never repeat the literal.
 */
export class RunConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunConfigurationError";
  }
}

/** The Temporal application failure type of `RunConfigurationError`. */
export const RUN_CONFIGURATION_ERROR_TYPE = "RunConfigurationError";
