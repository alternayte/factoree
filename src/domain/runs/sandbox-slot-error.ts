/**
 * docs/specs/release-0-1-0.md, DI-15.14. The sandbox provider runs `sandboxMaxLive` sandboxes of
 * Factoree, and none of them is retained for inspection, so no sandbox can start now. It is not a
 * fault: the workflow waits and asks again, bounded by the Run budget.
 *
 * The Temporal failure converter puts the error name in the `type` of the application failure,
 * so the workflow and the retry policy read `SANDBOX_SLOT_UNAVAILABLE_TYPE`.
 */
export class SandboxSlotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxSlotUnavailableError";
  }
}

/** The Temporal application failure type of `SandboxSlotUnavailableError`. */
export const SANDBOX_SLOT_UNAVAILABLE_TYPE = "SandboxSlotUnavailableError";
