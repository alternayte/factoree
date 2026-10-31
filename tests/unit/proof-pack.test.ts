import { describe, expect, it } from "vitest";
import {
  buildProofPackDocument,
  hashProofPack,
  MAX_LISTED_CHANGED_FILES,
  PROOF_PACK_HEADINGS,
  renderProofPack,
  type ProofPackInput,
} from "~/domain/evidence/proof-pack.js";
import { summarizeAgentSessions, type RecordAgentSessionInput } from "~/domain/runs/agent-session.js";

const input = (overrides: Partial<ProofPackInput> = {}): ProofPackInput => ({
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
          storageRef: "file:VAL-API-001-http-request-response.json",
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
  reviewPasses: 1,
  findings: [],
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
  discoverableItemCount: 3,
  conflicts: [],
  changedFiles: ["src/health.ts"],
  patchByteLength: 812,
  checkPreviewUrl: null,
  changeDescription: "The change adds a health endpoint that answers 200.",
  visualEvidenceGap: null,
  baseSha: "f".repeat(40),
  patchSha256: "e".repeat(64),
  commitSha: "1".repeat(40),
  repairCount: 0,
  repairLimit: 2,
  ...overrides,
});

const DOCUMENT_URL = "https://uploads.linear.app/run-1/proof-pack.json";
const render = (overrides: Partial<ProofPackInput> = {}): string => renderProofPack(input(overrides), DOCUMENT_URL);

const screenshot = {
  kind: "screenshot" as const,
  source: "browser:VAL-UI-001:final",
  sha256: "9".repeat(64),
  storageRef: "https://uploads.linear.app/run-1/VAL-UI-001-final.png",
};

const uiAssertion = {
  id: "VAL-UI-001",
  requirement: "AC-2",
  statement: "The footer shows the app version.",
  method: "browser" as const,
  requiredEvidence: ["screenshot" as const],
  result: "PASS" as const,
  reason: "The footer text matched.",
  evidence: [
    screenshot,
    { ...screenshot, kind: "video" as const, storageRef: "https://uploads.linear.app/run-1/VAL-UI-001.webm" },
  ],
};

describe("the Proof Pack body (proof-pack-and-visual-evidence.md)", () => {
  it("writes every heading exactly once and in order", () => {
    // The leading newline lets the first heading match the same pattern as every later one.
    const body = `\n${render()}`;
    let cursor = -1;
    for (const heading of PROOF_PACK_HEADINGS) {
      const at = body.indexOf(`\n${heading}\n`);
      expect(at, `${heading} is missing`).toBeGreaterThan(cursor);
      expect(body.indexOf(`\n${heading}\n`, at + 1), `${heading} appears twice`).toBe(-1);
      cursor = at;
    }
  });

  it("opens with the status, the Reviewer's labelled description, and the links", () => {
    const body = render();
    const top = body.slice(0, body.indexOf("### Needs your attention"));
    expect(top).toContain("**Ready for human review.** Add the health endpoint");
    expect(top).toContain("> The change adds a health endpoint that answers 200.");
    expect(top).toContain("_The Reviewer's description of the change._");
    expect(top).toContain("**Pull request:** https://github.com/acme/fixture/pull/1");
    expect(top).toContain("**Preview:**");
  });

  it('says "Nothing." when nothing needs a human', () => {
    expect(render()).toMatch(/### Needs your attention\n\nNothing\./);
  });

  it("puts every item that needs a human above the checks", () => {
    const body = render({
      checkDefiningFiles: ["package.json"],
      findings: [
        {
          id: "F-1",
          severity: "low",
          category: "maintainability",
          requirement: "AC-1",
          evidence: "tsconfig.tsbuildinfo",
          description: "The change commits a build cache.",
          blocking: false,
          decisionReason: "the severity low does not block",
          attempt: 1,
        },
      ],
      assertions: [{ ...uiAssertion, result: "MANUAL_REQUIRED", reason: "A human must look." }],
      visualEvidenceGap: 'No visual evidence for "The page loads.": the repository has no preview.',
    });
    const attention = body.slice(body.indexOf("### Needs your attention"), body.indexOf("### Visual evidence"));
    expect(attention).toContain("package.json");
    expect(attention).toContain("F-1 (low, maintainability) at tsconfig.tsbuildinfo");
    expect(attention).toContain("It did not block, because the severity low does not block");
    expect(attention).toContain("VAL-UI-001 is MANUAL_REQUIRED");
    expect(attention).toContain("the repository has no preview");
  });

  it("shows a screenshot inline and links the video", () => {
    const body = render({ assertions: [uiAssertion] });
    expect(body).toContain("![VAL-UI-001](https://uploads.linear.app/run-1/VAL-UI-001-final.png)");
    expect(body).toContain("[VAL-UI-001 video](https://uploads.linear.app/run-1/VAL-UI-001.webm)");
  });

  it("links no evidence a reader cannot open", () => {
    const local = { ...uiAssertion, evidence: [{ ...screenshot, storageRef: "file:///tmp/factoree-evidence/a.png" }] };
    const body = render({ assertions: [local] });
    expect(body).not.toContain("file:");
    expect(body).toMatch(/### Visual evidence\n\nNone captured\./);
  });

  it("states each assertion once, with its result and its criterion", () => {
    const body = render();
    expect(body.match(/VAL-API-001/g)).toHaveLength(1);
    expect(body).toContain("- PASS VAL-API-001: GET /health returns 200.");
  });

  it("writes one line per check, and the review result", () => {
    const body = render();
    expect(body).toContain("- PASS unit: `npm test`");
    expect(body).toContain("- PASS Independent review: 1 pass, 0 findings, 0 blocking.");
  });

  it("carries no context list, no hash and no file list", () => {
    const body = render();
    expect(body).not.toContain("github:acme/fixture/README.md");
    expect(body).not.toContain("e".repeat(64));
    expect(body).not.toContain("f".repeat(40));
    expect(body).not.toContain("src/health.ts");
  });

  it("ends with the Run, the autonomy level, the repairs and the document link", () => {
    expect(render({ autonomyLevel: "L2" })).toContain(
      `Run run-1 · L2 · repairs 0 of 2 · [proof-pack.json](${DOCUMENT_URL})`,
    );
  });

  it("keeps a newline of a free text field out of a list line", () => {
    const body = render({ assertions: [{ ...uiAssertion, statement: "The footer\nshows the version." }] });
    expect(body).toContain("- PASS VAL-UI-001: The footer shows the version.");
  });

  it("hashes one body to one value and two bodies to two values", () => {
    const body = render();
    expect(hashProofPack(body)).toBe(hashProofPack(body));
    expect(hashProofPack(body)).not.toBe(hashProofPack(`${body} `));
    expect(hashProofPack(body)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("proof-pack.json (proof-pack-and-visual-evidence.md)", () => {
  it("holds the context, the hashes, the evidence and the run metadata", () => {
    const document = buildProofPackDocument(input({ autonomyLevel: "L3" }));
    expect(document.context.items[0]?.contentSha256).toBe("d".repeat(64));
    expect(document.assertions[0]?.evidence[0]?.storageRef).toBe("file:VAL-API-001-http-request-response.json");
    expect(document.run).toMatchObject({ baseSha: "f".repeat(40), patchSha256: "e".repeat(64), autonomyLevel: "L3" });
    expect(document.needsAttention).toEqual([]);
  });

  it("caps the file list and keeps the full count", () => {
    const files = Array.from({ length: MAX_LISTED_CHANGED_FILES + 7 }, (_, index) => `src/file-${index}.ts`);
    const document = buildProofPackDocument(input({ changedFiles: files }));
    expect(document.change.changedFiles).toHaveLength(MAX_LISTED_CHANGED_FILES);
    expect(document.change.changedFileCount).toBe(MAX_LISTED_CHANGED_FILES + 7);
  });
});

describe("decisions and a moved base (own-proposals-and-parallel-runs.md)", () => {
  it("lists a conflict first, then the move, then each decision, and keeps both in proof-pack.json", () => {
    const decisions = [
      { kind: "target" as const, statement: "chose alternayte/c-dash", reason: "the issue names c-dash" },
      { kind: "not_built" as const, statement: 'did not build "also email the admin"', reason: "no ticket sentence implies it" },
    ];
    const baseMove = { baseBranch: "main", headSha: "9".repeat(40), ahead: 3, conflicts: ["src/app.ts"] };
    const document = buildProofPackDocument(input({ decisions, baseMove }));
    expect(document.needsAttention).toEqual([
      "Conflicts with main in `src/app.ts`.",
      "Verified on `fffffff`. main is now `9999999`, 3 commits ahead.",
      "Factoree chose alternayte/c-dash, because the issue names c-dash.",
      'Not built: "also email the admin".',
    ]);
    expect(document.decisions).toEqual(decisions);
    expect(document.baseMove).toEqual(baseMove);
  });
});

describe("agent usage (agent-session-usage-and-hangs.md)", () => {
  const usage = (costUsd: number, turns: number) => ({
    inputTokens: 1_000,
    outputTokens: 2_000,
    reasoningTokens: 500,
    cacheReadTokens: 10_000,
    cacheWriteTokens: 0,
    costUsd,
    turns,
    longestTurnMs: 30_000,
  });
  const row = (role: "refiner" | "implementer" | "validator" | "reviewer", overrides: Partial<RecordAgentSessionInput> = {}): RecordAgentSessionInput => ({
    tenantId: "tenant-1",
    runId: "run-1",
    role,
    attempt: 1,
    runner: "opencode",
    cliSessionId: "ses_1",
    model: "deepseek/deepseek-flash",
    effort: null,
    usage: usage(0.5, 4),
    durationMs: 90_000,
    outcome: "finished",
    idempotencyKey: `run:run-1:${role}:1`,
    ...overrides,
  });

  it("totals each role and the whole Run, and counts a session with no usage record apart", () => {
    const totals = summarizeAgentSessions([
      row("implementer"),
      row("implementer", { attempt: 2, outcome: "hung", usage: usage(1.25, 9) }),
      row("reviewer", { usage: null, durationMs: 30_000 }),
      row("refiner"),
    ]);
    expect(totals.roles.map((entry) => entry.role)).toEqual(["refiner", "implementer", "reviewer"]);
    expect(totals.roles[1]).toMatchObject({ sessions: 2, hung: 1, costUsd: 1.75, modelTimeMs: 180_000 });
    expect(totals.roles[2]).toMatchObject({ sessions: 1, sessionsWithoutUsage: 1, costUsd: 0 });
    expect(totals.costUsd).toBe(2.25);
    expect(totals.tokens).toBe(3 * 13_500);
    expect(totals.modelTimeMs).toBe(300_000);
  });

  it("shows one line with the cost, the tokens and the model time, and keeps the totals in proof-pack.json", () => {
    const agentUsage = summarizeAgentSessions([row("implementer"), row("reviewer", { usage: null })]);
    const body = renderProofPack(input({ agentUsage }), null);
    expect(body).toContain("**Agent usage:** $0.50 · 13,500 tokens · 3m 0s model time · 1 session without a usage record");
    expect(body.indexOf("**Agent usage:**")).toBeGreaterThan(body.indexOf("### Checks"));
    expect(buildProofPackDocument(input({ agentUsage })).agentUsage?.roles).toHaveLength(2);
  });

  it("shows no usage line when the Run recorded no session", () => {
    expect(renderProofPack(input({ agentUsage: summarizeAgentSessions([]) }), null)).not.toContain("Agent usage");
    expect(buildProofPackDocument(input()).agentUsage).toBeNull();
  });
});
