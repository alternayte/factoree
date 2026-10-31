import { describe, expect, it } from "vitest";
import {
  completionInvariantFailures,
  type CompletionInvariantInput,
} from "~/domain/runs/completion-invariant.js";
import { RUN_FAILURE_REASONS } from "~/domain/runs/run-status.js";

const satisfied = (overrides: Partial<CompletionInvariantInput> = {}): CompletionInvariantInput => ({
  workItemReady: true,
  contextContractVersion: "a".repeat(64),
  unresolvedConflict: false,
  validationContractVersion: "b".repeat(64),
  validationContractFrozenAt: "2026-01-01T00:00:00.000Z",
  implementationStartedAt: "2026-01-01T00:05:00.000Z",
  validationPassed: true,
  verificationPassed: true,
  blockingFindingCount: 0,
  repairCount: 1,
  repairLimit: 2,
  patchSha256: "c".repeat(64),
  pullRequestUrl: "https://github.com/acme/fixture/pull/1",
  proofPackSha256: "d".repeat(64),
  ...overrides,
});

describe("the SDD section 68 completion invariant", () => {
  it("reports no failure when every clause holds", () => {
    expect(completionInvariantFailures(satisfied())).toEqual([]);
  });

  it("names the failure reason", () => {
    expect(RUN_FAILURE_REASONS).toContain("COMPLETION_INVARIANT_UNMET");
  });

  const cases: Array<[string, Partial<CompletionInvariantInput>, string]> = [
    ["the Work Item is not ready", { workItemReady: false }, "Work Item"],
    ["no Context Contract exists", { contextContractVersion: null }, "Context Contract"],
    ["a material conflict is unresolved", { unresolvedConflict: true }, "conflict"],
    ["no Validation Contract exists", { validationContractVersion: null }, "Validation Contract"],
    ["the contract never froze", { validationContractFrozenAt: null }, "froze"],
    ["one assertion did not pass", { validationPassed: false }, "assertion"],
    ["deterministic verification failed", { verificationPassed: false }, "verification"],
    ["a blocking finding remains", { blockingFindingCount: 1 }, "blocking"],
    ["the repair budget is exceeded", { repairCount: 3 }, "repair"],
    ["no patch hash exists", { patchSha256: "" }, "patch hash"],
    ["no pull request exists", { pullRequestUrl: null }, "pull request"],
    ["no Proof Pack exists", { proofPackSha256: null }, "Proof Pack"],
  ];

  for (const [name, override, fragment] of cases) {
    it(`refuses completion when ${name}`, () => {
      const failures = completionInvariantFailures(satisfied(override));
      expect(failures.length).toBeGreaterThan(0);
      expect(failures.join(" ")).toContain(fragment);
    });
  }

  it("refuses a contract that froze after implementation started", () => {
    // SDD section 24 names an ORDER. A check that only proves a contract exists would accept a
    // contract frozen against an implementation that was already running.
    const failures = completionInvariantFailures(
      satisfied({
        validationContractFrozenAt: "2026-01-01T00:10:00.000Z",
        implementationStartedAt: "2026-01-01T00:05:00.000Z",
      }),
    );
    expect(failures).toEqual(["The Validation Contract froze after implementation started."]);
  });

  it("refuses completion when no implementation start was recorded", () => {
    expect(completionInvariantFailures(satisfied({ implementationStartedAt: null }))).toEqual([
      "No implementation start was recorded, so the freeze order is unproved.",
    ]);
  });

  it("accepts a contract that froze at the same moment implementation started", () => {
    expect(
      completionInvariantFailures(satisfied({ implementationStartedAt: "2026-01-01T00:00:00.000Z" })),
    ).toEqual([]);
  });

  it("refuses a patch hash that is not a SHA-256", () => {
    expect(completionInvariantFailures(satisfied({ patchSha256: "not-a-hash" }))).not.toEqual([]);
  });

  it("refuses a Proof Pack hash that is not a SHA-256", () => {
    expect(completionInvariantFailures(satisfied({ proofPackSha256: "short" }))).not.toEqual([]);
  });

  it("refuses a blank pull request URL, not only a null one", () => {
    expect(completionInvariantFailures(satisfied({ pullRequestUrl: "   " }))).not.toEqual([]);
  });

  it("accepts a repair count that equals the limit", () => {
    expect(completionInvariantFailures(satisfied({ repairCount: 2, repairLimit: 2 }))).toEqual([]);
  });

  it("reports every broken clause, not only the first one", () => {
    const failures = completionInvariantFailures(
      satisfied({ pullRequestUrl: null, proofPackSha256: null }),
    );
    expect(failures.length).toBe(2);
  });
});
