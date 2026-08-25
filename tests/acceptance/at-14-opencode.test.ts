import { describe, expect, it } from "vitest";
import { driveFixtureToVerification } from "./support/runner-fixture.js";

/**
 * SDD section 64, AT-14. The fixture implementation reaches verification with OpenCodeRunner.
 */
describe("AT-14 — OpenCode", () => {
  it("reaches passing deterministic verification with the opencode runner", async () => {
    const outcome = await driveFixtureToVerification({ runnerName: "opencode", honest: true });
    expect(outcome.runnerName).toBe("opencode");
    expect(outcome.verificationPassed).toBe(true);
  }, 60_000);

  it("blocks a false success claim, because the claim never decides the outcome", async () => {
    const outcome = await driveFixtureToVerification({ runnerName: "opencode", honest: false });
    expect(outcome.claimedCompleted).toBe(true);
    expect(outcome.verificationPassed).toBe(false);
  }, 60_000);
});
