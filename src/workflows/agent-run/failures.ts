import { ApplicationFailure } from "@temporalio/workflow";
// The workflow bundler resolves a relative path only. These modules import nothing at run time.
import { RUN_CONFIGURATION_ERROR_TYPE } from "../../domain/runs/run-configuration-error.js";
import { withCauseText } from "../../domain/runs/failure-cause.js";
import { SANDBOX_PROVIDER_DOWN_TYPE, SANDBOX_SLOT_UNAVAILABLE_TYPE } from "../../domain/runs/sandbox-slot-error.js";

/**
 * Reports whether a failure, or any cause below it, is an application failure of this type.
 * Temporal wraps an activity error, so the type appears on a cause rather than on the top error.
 */
const hasFailureType = (error: unknown, type: string): boolean => {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof ApplicationFailure && current.type === type) return true;
  }
  return false;
};

/** The configuration error of the domain. The Run ends FAILED_CONFIGURATION. */
export const isConfigurationFault = (error: unknown): boolean => hasFailureType(error, RUN_CONFIGURATION_ERROR_TYPE);
/** DI-15.14. Every sandbox provider of the run is full. */
export const isSandboxSlotUnavailable = (error: unknown): boolean => hasFailureType(error, SANDBOX_SLOT_UNAVAILABLE_TYPE);
/** docs/specs/sandbox-provider-spillover.md. The work sprite create failed at the provider of the run. */
export const isSandboxProviderDown = (error: unknown): boolean => hasFailureType(error, SANDBOX_PROVIDER_DOWN_TYPE);

/**
 * docs/specs/run-failure-detail.md. The error text that names the cause of a failure: the message
 * of the configuration error when the chain holds one, else the innermost message.
 */
export const causeOf = (error: unknown): string => {
  let innermost = "";
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof ApplicationFailure && current.type === RUN_CONFIGURATION_ERROR_TYPE) return current.message;
    if (current.message.trim() !== "") innermost = current.message;
  }
  return innermost;
};

/** The fixed sentence of a failed step, then the cause of its error. */
export const withCause = (sentence: string, error: unknown): string => withCauseText(sentence, causeOf(error));

/** Maps a publication failure to its SDD failure reason. */
export const publicationFailureReasonOf = (error: unknown): "PATCH_HASH_MISMATCH" | "EMPTY_PATCH" | "PUBLICATION_FAILED" =>
  hasFailureType(error, "PATCH_HASH_MISMATCH") ? "PATCH_HASH_MISMATCH" : hasFailureType(error, "EMPTY_PATCH") ? "EMPTY_PATCH" : "PUBLICATION_FAILED";

/** A Linear post or another best-effort call must not abort the workflow after the durable state is written. */
export const notify = async (send: () => Promise<unknown>): Promise<void> => {
  try {
    await send();
  } catch {
    // The durable state is already written. The call is best effort.
  }
};

/** docs/specs/sandbox-memory-and-size.md. The run sentence of a sandbox fault in a check sprite. */
export const SANDBOX_FAULT_SENTENCE = "A check stopped on a sandbox fault, so Factoree spent no repair.";

/** Part of every sandbox fault message (`sandboxFaultSentence` in src/domain/runs/sandbox-fault.ts). */
const SANDBOX_FAULT_MARK = "This is a sandbox fault, not a code failure";

/** True when a configuration fault is a sandbox fault, by the sentence its message carries. */
export const isSandboxFault = (error: unknown): boolean => isConfigurationFault(error) && causeOf(error).includes(SANDBOX_FAULT_MARK);
