/**
 * docs/specs/run-workflow-structure.md. The release of this workflow code, recorded in the memo of
 * each new agentRun workflow as `factoreeRelease`. The release commit sets it with package.json;
 * `tests/unit/upgrade-check.test.ts` fails when the two differ.
 */
export const FACTOREE_RELEASE = "0.21.7";

/**
 * The oldest release whose open agentRun workflows this code replays. 0.16.0 removed the old
 * branch of every `patched` gate (`deprecatePatch`), so a run that an earlier release started
 * cannot replay. Raise it only in a release that removes replay support again.
 */
export const MIN_REPLAYABLE_RELEASE = "0.16.0";

/** The memo key of the release that started an agentRun workflow. */
export const RELEASE_MEMO_KEY = "factoreeRelease";

/** The memo of a new agentRun workflow. */
export const releaseMemo = (): Record<string, string> => ({ [RELEASE_MEMO_KEY]: FACTOREE_RELEASE });
