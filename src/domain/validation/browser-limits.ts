/**
 * Issue #44, DI-21.68. The fixed limits of a browser check. A step that never matches fails in
 * the step limit, not in a share of the whole Run budget. A repository can change both limits in
 * `.factoree/config.yaml` under `validation.browser`, inside these bounds.
 */
export const BROWSER_STEP_TIMEOUT_SECONDS = { default: 30, min: 5, max: 300 } as const;
export const BROWSER_SCENARIO_TIMEOUT_SECONDS = { default: 180, min: 30, max: 1800 } as const;

/** The limits of one browser scenario, in milliseconds. */
export interface BrowserLimits {
  stepTimeoutMs: number;
  scenarioTimeoutMs: number;
}

export const DEFAULT_BROWSER_LIMITS: BrowserLimits = {
  stepTimeoutMs: BROWSER_STEP_TIMEOUT_SECONDS.default * 1000,
  scenarioTimeoutMs: BROWSER_SCENARIO_TIMEOUT_SECONDS.default * 1000,
};

/**
 * DI-21.68. The limits one scenario runs with: the scenario limit, or what is left of the Run
 * budget when that is less, and the step limit, never more than the scenario limit.
 */
export const effectiveBrowserLimits = (limits: BrowserLimits, remainingRunMs: number): BrowserLimits => {
  const scenarioTimeoutMs = Math.max(0, Math.min(limits.scenarioTimeoutMs, remainingRunMs));
  return { scenarioTimeoutMs, stepTimeoutMs: Math.min(limits.stepTimeoutMs, scenarioTimeoutMs) };
};

/** A limit as a person reads it in a reason: "30 s", "1.5 s", "3 min". */
export const describeLimit = (ms: number): string => {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
};
