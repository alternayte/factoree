import { describe, expect, it } from "vitest";
import { driveFixtureToVerification } from "./support/runner-fixture.js";

/**
 * SDD section 64, AT-15. The same fixture reaches verification with ClaudeCodeRunner.
 */
describe("AT-15 — Claude", () => {
  it("reaches passing deterministic verification with the claude runner", async () => {
    const outcome = await driveFixtureToVerification({ runnerName: "claude", honest: true });
    expect(outcome.runnerName).toBe("claude");
    expect(outcome.verificationPassed).toBe(true);
  }, 60_000);

  it("blocks a false success claim, because the claim never decides the outcome", async () => {
    const outcome = await driveFixtureToVerification({ runnerName: "claude", honest: false });
    expect(outcome.claimedCompleted).toBe(true);
    expect(outcome.verificationPassed).toBe(false);
  }, 60_000);
});
