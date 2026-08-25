import { describe, expect, it } from "vitest";
import { renderProofPack, type ProofPackInput } from "~/domain/evidence/proof-pack.js";
import {
  completionInvariantFailures,
  type CompletionInvariantInput,
} from "~/domain/runs/completion-invariant.js";

/**
 * The Phase 10 exit condition. A human decides whether to accept the change without reading the
 * Implementer transcript. The three groups below make that claim testable: the Proof Pack
 * answers every question the decision needs, it carries no transcript and no raw log, and the
 * Run reaches its success terminal state only after the Proof Pack exists.
 *
 * AT-30 proves the same claim against a real database in `at-30-proof-pack.test.ts`. This file
 * states the exit condition itself.
 */

const provedRun = (overrides: Partial<ProofPackInput> = {}): ProofPackInput => ({
  runId: "run-1",
  workItem: { title: "Add the health endpoint", url: "https://linear.app/acme/issue/ENG-143" },
  pullRequestUrl: "https://github.com/acme/fixture/pull/1",
  assertions: [
    {
      id: "VAL-API-001",
      requirement: "AC-1",
      statement: "GET /health returns 200.",
      method: "http",
      requiredEvidence: ["request-response"],
      result: "PASS",
      reason: "The endpoint answered 200.",
      evidence: [
        {
          kind: "request-response",
          source: "http:VAL-API-001:request-response",
          sha256: "a".repeat(64),
          storageRef: "file:VAL-API-001.json",
        },
      ],
    },
  ],
  checks: [
    {
      name: "unit",
      command: "npm test",
      exitCode: 0,
      passed: true,
      durationMs: 1200,
      stdoutSha256: "b".repeat(64),
      stderrSha256: "c".repeat(64),
    },
  ],
  reviewVerdict: "pass",
  reviewPasses: 2,
  findings: [
    {
      id: "RV-2",
      severity: "high",
      category: "performance",
      requirement: "AC-1",
      evidence: "src/health.ts:12",
      description: "The handler reads the whole table on every request.",
      blocking: false,
      decisionReason: "the finding names no mandatory requirement of this Work Item",
      attempt: 2,
    },
  ],
  contextItems: [
    {
      ref: "github:acme/fixture/README.md",
      authority: "repository_readme",
      classification: "required",
      sourceVersion: "824ac31",
      contentSha256: "d".repeat(64),
      reason: "it states the health endpoint contract",
    },
  ],
  discoverableItemCount: 2,
  conflicts: [
    {
      id: "CTX-4",
      subject: "notification ownership",
      winnerRef: "ADR-031",
      loserRef: "README.md",
      reason: "an accepted ADR has higher architecture authority",
    },
  ],
  changedFiles: ["src/health.ts", "tests/health.test.ts"],
  patchByteLength: 812,
  previewUrl: null,
  baseSha: "5".repeat(40),
  patchSha256: "4".repeat(64),
  commitSha: "3".repeat(40),
  repairCount: 1,
  repairLimit: 2,
  ...overrides,
});

const satisfied = (overrides: Partial<CompletionInvariantInput> = {}): CompletionInvariantInput => ({
  workItemReady: true,
  contextContractVersion: "a".repeat(64),
  unresolvedConflict: false,
  validationContractVersion: "b".repeat(64),
  validationContractFrozenAt: "2026-01-01T00:00:00.000Z",
  validationPassed: true,
  verificationPassed: true,
  blockingFindingCount: 0,
  repairCount: 1,
  repairLimit: 2,
  patchSha256: "4".repeat(64),
  baseUnchanged: true,
  pullRequestUrl: "https://github.com/acme/fixture/pull/1",
  proofPackSha256: "9".repeat(64),
  ...overrides,
});

describe("Phase 10 exit — a human decides from the Proof Pack alone", () => {
  const body = renderProofPack(provedRun());

  const questions: Array<[string, string]> = [
    ["Where is the change?", "https://github.com/acme/fixture/pull/1"],
    ["What was promised?", "GET /health returns 200."],
    ["Was the promise kept?", "| VAL-API-001 | PASS |"],
    ["What proves it?", "file:VAL-API-001.json"],
    ["Did the build pass?", "exit code 0"],
    ["What did the reviewer say?", "The last Reviewer verdict was pass"],
    ["Does a blocking defect remain?", "Blocking findings that remain: 0"],
    ["What did Factoree read?", "github:acme/fixture/README.md"],
    ["On whose authority?", "authority repository_readme"],
    ["Which conflicts were settled?", "ADR-031"],
    ["What changed?", "2 files, 812 patch bytes."],
    ["What must I still weigh?", "the finding names no mandatory requirement"],
    ["How many repairs did it need?", "Repairs: 1 of 2"],
    ["Against which base?", "5".repeat(40)],
    ["Which exact patch?", "4".repeat(64)],
  ];

  for (const [question, evidence] of questions) {
    it(`answers the acceptance question: ${question}`, () => {
      expect(body).toContain(evidence);
    });
  }

  it("names a high finding that did not block, with the reason it did not", () => {
    // The Phase 8 carried finding. A defect that failed only one gate must reach the human.
    expect(body).toContain("RV-2 (high, performance)");
    expect(body).toContain("It did not block, because");
  });

  it("carries no Implementer transcript and no raw log", () => {
    // The renderer accepts no log field at all, so a transcript cannot reach Linear even when a
    // caller holds one. `ProofPackCheck` carries the two output hashes instead of the output.
    expect(body).not.toContain("IMPLEMENTER TRANSCRIPT");
    expect(body).not.toContain("--- stdout ---");
    expect(body).not.toContain("--- stderr ---");
    expect(body).toContain("stdout bbbbbbbbbbbb");
  });

  it("stays short enough for one human to read", () => {
    expect(body.length).toBeLessThan(8_000);
  });

  it("refuses completion while no Proof Pack exists", () => {
    // The machine-checked form of the exit condition. A Run whose human cannot decide must not
    // report that it is ready for that human.
    expect(completionInvariantFailures(satisfied({ proofPackSha256: null }))).toEqual([
      "No Proof Pack exists.",
    ]);
  });

  it("allows completion once every clause holds", () => {
    expect(completionInvariantFailures(satisfied())).toEqual([]);
  });
});
