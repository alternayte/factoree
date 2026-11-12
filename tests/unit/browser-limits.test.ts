import { describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_LIMITS, describeLimit, effectiveBrowserLimits } from "~/domain/validation/browser-limits.js";

describe("effectiveBrowserLimits (issue #44, DI-21.68)", () => {
  it("keeps the fixed limits when the Run has more time left", () => {
    // The 0.9.0 run had 82 minutes left, and a 10-step plan gave each step 8 minutes.
    expect(effectiveBrowserLimits(DEFAULT_BROWSER_LIMITS, 4_951_181)).toEqual({ stepTimeoutMs: 30_000, scenarioTimeoutMs: 180_000 });
  });

  it("cuts the scenario limit to the time left, and the step limit with it", () => {
    expect(effectiveBrowserLimits(DEFAULT_BROWSER_LIMITS, 100_000)).toEqual({ stepTimeoutMs: 30_000, scenarioTimeoutMs: 100_000 });
    expect(effectiveBrowserLimits(DEFAULT_BROWSER_LIMITS, 12_000)).toEqual({ stepTimeoutMs: 12_000, scenarioTimeoutMs: 12_000 });
  });

  it("never gives a step more than the scenario limit, and never a negative limit", () => {
    expect(effectiveBrowserLimits({ stepTimeoutMs: 300_000, scenarioTimeoutMs: 60_000 }, 1_000_000)).toEqual({
      stepTimeoutMs: 60_000,
      scenarioTimeoutMs: 60_000,
    });
    expect(effectiveBrowserLimits(DEFAULT_BROWSER_LIMITS, -5)).toEqual({ stepTimeoutMs: 0, scenarioTimeoutMs: 0 });
  });
});

describe("describeLimit", () => {
  it("writes a limit as a person reads it", () => {
    expect(describeLimit(30_000)).toBe("30 s");
    expect(describeLimit(1_500)).toBe("1.5 s");
    expect(describeLimit(180_000)).toBe("3 min");
    expect(describeLimit(90_000)).toBe("90 s");
  });
});
