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

/**
 * docs/specs/sandbox-provider-spillover.md. The work sprite create failed at the provider the run
 * was pinned to. The provider is marked down, the run holds no slots there now, and the workflow
 * selects a provider again. The retry policy must not spend its attempts on it.
 */
export class SandboxProviderDownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxProviderDownError";
  }
}

/** The Temporal application failure type of `SandboxProviderDownError`. */
export const SANDBOX_PROVIDER_DOWN_TYPE = "SandboxProviderDownError";
