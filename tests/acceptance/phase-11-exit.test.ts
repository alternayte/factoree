import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { driveFixtureToVerification } from "./support/runner-fixture.js";

/**
 * SDD section 69, Phase 11 exit: the same fixture workflow works with either required runner.
 *
 * The test drives ONE fixture drive twice, and changes only the runner name in
 * `.factoree/config.yaml`. Nothing else differs, so a pass proves that the workflow itself
 * needed no change for the second runner. SDD section 33 requires exactly that.
 */
describe("Phase 11 exit condition", () => {
  it("reaches passing verification with either required runner, through the same drive", async () => {
    const openCode = await driveFixtureToVerification({ runnerName: "opencode", honest: true });
    const claude = await driveFixtureToVerification({ runnerName: "claude", honest: true });

    expect(openCode.runnerName).toBe("opencode");
    expect(claude.runnerName).toBe("claude");
    expect(openCode.verificationPassed).toBe(true);
    expect(claude.verificationPassed).toBe(true);
  }, 120_000);

  it("blocks a false claim with either required runner", async () => {
    const openCode = await driveFixtureToVerification({ runnerName: "opencode", honest: false });
    const claude = await driveFixtureToVerification({ runnerName: "claude", honest: false });
    expect(openCode.claimedCompleted).toBe(true);
    expect(claude.claimedCompleted).toBe(true);
    expect(openCode.verificationPassed).toBe(false);
    expect(claude.verificationPassed).toBe(false);
  }, 120_000);

  it("names both required adapters of SDD section 33 in the worker registry", async () => {
    const worker = await readFile("src/bin/worker.ts", "utf8");
    expect(worker).toContain("new OpenCodeRunner(");
    expect(worker).toContain("new ClaudeCodeRunner(");
  });

  it("keeps the two runner acceptance tests identical apart from the runner name", async () => {
    const openCode = await readFile("tests/acceptance/at-14-opencode.test.ts", "utf8");
    const claude = await readFile("tests/acceptance/at-15-claude-code.test.ts", "utf8");
    const normalize = (text: string): string =>
      text.replace(/opencode/g, "RUNNER").replace(/claude/g, "RUNNER").replace(/AT-1[45][^\n]*/g, "AT");
    expect(normalize(openCode)).toBe(normalize(claude));
  });
});
