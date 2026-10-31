/**
 * docs/specs/release-0-1-0.md, DI-15.13. A Product runs at most `maxConcurrentRuns` Runs past the
 * gate before PREPARING. A Run that holds a slot keeps it until its status is terminal, so every
 * terminal write releases it, a failure and a timeout included. A Run over the limit waits in the
 * state QUEUED, and the queue starts in delegation order.
 */
export type RunSlotClaim =
  | { granted: true }
  | {
      granted: false;
      /**
       * The Runs that must start or end before this one starts: the queued Runs delegated
       * earlier, and the excess of the Runs that hold a slot. At least 1.
       */
      ahead: number;
    };

export interface RunSlots {
  /**
   * Grants the Run a slot of its Product, or puts it in the queue. A Run that holds a slot gets
   * it again, so a retry of the claim is safe. Two claims of one Product never run at once.
   */
  claim(runId: string): Promise<RunSlotClaim>;
}

/** The Linear line of a queued Run. The spec fixes its wording. */
export const queuedMessage = (ahead: number): string => `Queued: ${ahead} runs ahead.`;
