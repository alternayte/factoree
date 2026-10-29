import { describe, expect, it } from "vitest";
import {
  hashProofPack,
  MAX_LISTED_CHANGED_FILES,
  PROOF_PACK_HEADINGS,
  renderProofPack,
  type ProofPackInput,
} from "~/domain/evidence/proof-pack.js";

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
  previewUrl: null,
  baseSha: "f".repeat(40),
  patchSha256: "e".repeat(64),
  commitSha: "1".repeat(40),
  repairCount: 0,
  repairLimit: 2,
  ...overrides,
});

describe("the Proof Pack renderer", () => {
  it("writes every SDD section 47 heading exactly once and in order", () => {
    // The leading newline lets the first heading match the same pattern as every later one.
    const body = `\n${renderProofPack(input())}`;
    let cursor = -1;
    for (const heading of PROOF_PACK_HEADINGS) {
      const at = body.indexOf(`\n${heading}\n`);
      expect(at, `${heading} is missing`).toBeGreaterThan(cursor);
      expect(body.indexOf(`\n${heading}\n`, at + 1), `${heading} appears twice`).toBe(-1);
      cursor = at;
    }
  });

  it("states the human decision status", () => {
    expect(renderProofPack(input())).toContain("Status: READY FOR HUMAN REVIEW");
  });

  it("maps every assertion to its result and its evidence", () => {
    const body = renderProofPack(input());
    expect(body).toContain("| Assertion | Result | Evidence |");
    expect(body).toContain("VAL-API-001");
    expect(body).toContain("PASS");
    expect(body).toContain("file:VAL-API-001-http-request-response.json");
  });

  it("states the success criterion of every assertion, so a human can audit it", () => {
    expect(renderProofPack(input())).toContain("GET /health returns 200.");
  });

  it("names an assertion with no stored evidence rather than hide it", () => {
    const body = renderProofPack(
      input({
        assertions: [{ ...input().assertions[0]!, evidence: [] }],
      }),
    );
    expect(body).toContain("No stored evidence.");
  });

  it("reports every deterministic check with its exit code", () => {
    const body = renderProofPack(input());
    expect(body).toContain("npm test");
    expect(body).toContain("exit code 0");
  });

  it("lists a non-blocking finding under known limitations with its decision reason", () => {
    const body = renderProofPack(
      input({
        findings: [
          {
            id: "RV-2",
            severity: "high",
            category: "performance",
            requirement: "AC-1",
            evidence: "src/health.ts:12",
            description: "The handler reads the whole table.",
            blocking: false,
            decisionReason: "the finding names no mandatory requirement",
            attempt: 1,
          },
        ],
      }),
    );
    expect(body).toContain("RV-2");
    expect(body).toContain("high");
    expect(body).toContain("the finding names no mandatory requirement");
  });

  it("writes None under known limitations when no finding survived", () => {
    expect(renderProofPack(input())).toMatch(/### Known limitations\n\nNone\./);
  });

  it("records the base SHA, the patch hash, and the repair count", () => {
    const body = renderProofPack(input());
    expect(body).toContain("f".repeat(40));
    expect(body).toContain("e".repeat(64));
    expect(body).toContain("Repairs: 0 of 2");
  });

  it("caps the changed-file list and states the remainder", () => {
    const files = Array.from({ length: 60 }, (_, index) => `src/file-${index}.ts`);
    const body = renderProofPack(input({ changedFiles: files }));
    expect(body).toContain("60 files");
    expect(body).toContain(`${60 - MAX_LISTED_CHANGED_FILES} more files`);
    expect(body).not.toContain("src/file-59.ts");
  });

  it("truncates one long field rather than post an unbounded text", () => {
    const body = renderProofPack(
      input({
        assertions: [{ ...input().assertions[0]!, reason: "x".repeat(4000) }],
      }),
    );
    expect(body).toContain("[truncated]");
    expect(body).not.toContain("x".repeat(1000));
  });

  it("keeps a newline out of a table cell and out of a criteria bullet", () => {
    const body = renderProofPack(
      input({
        assertions: [
          {
            ...input().assertions[0]!,
            reason: "line one\nline two",
            evidence: [
              {
                kind: "request-response",
                source: "http:VAL-API-001:request-response",
                sha256: "a".repeat(64),
                storageRef: "file:one\nfile:two",
              },
            ],
          },
        ],
      }),
    );
    const row = body.split("\n").find((line) => line.startsWith("| VAL-API-001"));
    expect(row).toContain("file:one file:two");
    expect(body).toContain("line one line two");
  });

  it("escapes a pipe inside a table cell", () => {
    const body = renderProofPack(
      input({
        assertions: [
          { ...input().assertions[0]!, id: "VAL|API|001", evidence: [], result: "PASS" },
        ],
      }),
    );
    const row = body.split("\n").find((line) => line.startsWith("| VAL\\|API"));
    expect(row).toBeDefined();
  });

  it("names a resolved context conflict with its winner and its reason", () => {
    const body = renderProofPack(
      input({
        conflicts: [
          {
            id: "CTX-4",
            subject: "notification ownership",
            winnerRef: "ADR-031",
            loserRef: "README.md",
            reason: "an accepted ADR has higher architecture authority",
          },
        ],
      }),
    );
    expect(body).toContain("CTX-4");
    expect(body).toContain("ADR-031");
    expect(body).toContain("an accepted ADR has higher architecture authority");
  });

  it("writes Not available under preview when the Run started none", () => {
    expect(renderProofPack(input())).toMatch(/### Preview\n\nNot available\./);
  });

  it("renders the Routing section with the product, the team, and every target", () => {
    const markdown = renderProofPack(
      input({
        routing: {
          productSlug: "checkout-platform",
          linearTeamKey: "PAY",
          targets: [
            {
              fullName: "acme/checkout-api",
              baseSha: "4f21c9e",
              pullRequestUrl: "https://github.com/acme/checkout-api/pull/812",
              mergeOrder: 1,
            },
          ],
          siblingsRead: [{ fullName: "acme/checkout-events", commitSha: "1b7d004" }],
          selectionReason: "sole member",
        },
      }),
    );

    expect(markdown).toContain("### Routing");
    expect(markdown).toContain("Product: checkout-platform");
    expect(markdown).toContain("Linear team: PAY");
    expect(markdown).toContain("acme/checkout-api @ 4f21c9e -> PR #812");
    expect(markdown).toContain("acme/checkout-events @ 1b7d004");
    expect(markdown).toContain("Selection reason: sole member");
  });

  it("folds a newline in the selection reason so the Routing section stays one line per field", () => {
    const markdown = renderProofPack(
      input({
        routing: {
          productSlug: "checkout-platform",
          linearTeamKey: "PAY",
          targets: [
            {
              fullName: "acme/checkout-api",
              baseSha: "4f21c9e",
              pullRequestUrl: "https://github.com/acme/checkout-api/pull/812",
              mergeOrder: 1,
            },
          ],
          siblingsRead: [],
          selectionReason: "declared coupling\nconfirmed by an operator",
        },
      }),
    );

    expect(markdown).toContain(
      "Selection reason: declared coupling confirmed by an operator",
    );
    expect(markdown).not.toContain("Selection reason: declared coupling\nconfirmed");
  });

  it("omits the Merge order line when the Run touched one target", () => {
    const markdown = renderProofPack(
      input({
        routing: {
          productSlug: "checkout-platform",
          linearTeamKey: "PAY",
          targets: [
            {
              fullName: "acme/checkout-api",
              baseSha: "4f21c9e",
              pullRequestUrl: "https://github.com/acme/checkout-api/pull/812",
              mergeOrder: 1,
            },
          ],
          siblingsRead: [],
          selectionReason: "sole member",
        },
      }),
    );

    expect(markdown).not.toContain("Merge order:");
    expect(markdown).toContain("Sibling repositories read: none.");
  });

  it("renders the Merge order line when the Run touched several targets", () => {
    const markdown = renderProofPack(
      input({
        routing: {
          productSlug: "checkout-platform",
          linearTeamKey: "PAY",
          targets: [
            {
              fullName: "acme/checkout-api",
              baseSha: "4f21c9e",
              pullRequestUrl: "https://github.com/acme/checkout-api/pull/812",
              mergeOrder: 1,
            },
            {
              fullName: "acme/checkout-web",
              baseSha: "88a0f2b",
              pullRequestUrl: "https://github.com/acme/checkout-web/pull/341",
              mergeOrder: 2,
            },
          ],
          siblingsRead: [{ fullName: "acme/checkout-events", commitSha: "1b7d004" }],
          selectionReason: "declared coupling",
        },
      }),
    );

    expect(markdown).toContain("2. acme/checkout-web @ 88a0f2b -> PR #341");
    expect(markdown).toContain("Merge order: checkout-api, then checkout-web");
  });

  it("hashes one body to one value and two bodies to two values", () => {
    const body = renderProofPack(input());
    expect(hashProofPack(body)).toBe(hashProofPack(body));
    expect(hashProofPack(body)).not.toBe(hashProofPack(`${body} `));
    expect(hashProofPack(body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("names the autonomy level and every cap that applied (autonomy-levels.md)", () => {
    const body = renderProofPack(
      input({ autonomyLevel: "L2", autonomyReasons: ['The label "payments" caps this Run at L2.'] }),
    );
    expect(body).toContain('- Autonomy level: L2. The label "payments" caps this Run at L2.');
  });

  it("lists the check-defining files first in the change summary (check-isolation.md)", () => {
    const body = renderProofPack(input({ changedFiles: ["src/a.ts", "package.json"], checkDefiningFiles: ["package.json"] }));
    const summary = body.slice(body.indexOf("### Change summary"));
    expect(summary.indexOf("- package.json")).toBeLessThan(summary.indexOf("- src/a.ts"));
    expect(summary).toContain("so the pull request is a draft");
  });
});
